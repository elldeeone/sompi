import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { exportJWK, generateKeyPair } from "jose";

import {
  Ap2HumanAuthorityDecisionProvider,
} from "../adapters/ap2/human-authority.js";
import type { AuthorityApprovalPrompt } from "./approval-ceremony.js";
import { TerminalAuthorityApprovalPrompt } from "./terminal-authority.js";
import {
  loadAp2TrustStore,
  loadAuthoritySigningIdentity,
} from "../adapters/ap2/signing-key-file.js";
import type { Ap2PublicTrustEntry, P256PublicJwk } from "../adapters/ap2/types.js";
import { KaspaX402AuthorityEvidenceVerifier } from "../adapters/kaspa-x402/authority-evidence-verifier.js";
import { SqliteAuthorityDecisionStore } from "./decision-store.js";
import { AuthorityDecisionEndpoint, AuthorityUnixDecisionServer } from "./endpoint.js";
import { AuthorityMacKeyFile } from "./key-provider.js";
import { AUTHORITY_MAC_KEY_BYTES } from "./protocol.js";
import { SqliteAuthorityReplayStore } from "./replay-store.js";
import { AuthorityService } from "./service.js";
import { AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS } from "./transport.js";
import type { AdmissionBudgetProjection } from "../admission.js";
import type { OperatorManifest } from "../operator/manifest.js";
import {
  TelegramAuthorityApprovalPrompt,
  TelegramAuthorityPromptStore,
  TelegramBotApi,
  startTelegramCallbackServer,
  type RunningTelegramCallbackServer,
} from "./telegram-authority.js";
import { AuthorityPromptAdmission } from "./prompt-admission.js";
import {
  OwnerAuthorityDecisionStore,
  OwnerAuthorityService,
  isOwnerAuthorityRequestWire,
} from "./owner-authority.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface AuthorityRuntimePaths {
  readonly privateDirectory: string;
  readonly clientDirectory: string;
  readonly runtimeDirectory: string;
  readonly callbackRuntimeDirectory: string;
  readonly serverMacKey: string;
  readonly clientMacKey: string;
  readonly privateJwk: string;
  readonly publicTrustEntry: string;
  readonly serverTrust: string;
  readonly clientTrust: string;
  readonly replayDatabase: string;
  readonly decisionDatabase: string;
  readonly telegramBotToken: string;
  readonly telegramPromptDatabase: string;
  readonly socket: string;
  readonly telegramCallbackSocket: string;
}

export interface AuthorityRuntimePathOptions {
  readonly rootDirectory?: string;
  readonly privateDirectory?: string;
  readonly clientDirectory?: string;
  readonly runtimeDirectory?: string;
  readonly callbackRuntimeDirectory?: string;
  readonly socketPath?: string;
}

export interface AuthorityClientRuntimePaths {
  readonly directory: string;
  readonly macKey: string;
  readonly trust: string;
  readonly socket: string;
}

export interface AuthorityClientRuntimePathOptions {
  readonly rootDirectory?: string;
  readonly clientDirectory?: string;
  readonly runtimeDirectory?: string;
  readonly socketPath?: string;
}

/** MCP-visible paths. This type cannot name or derive the authority signer. */
export function authorityClientRuntimePaths(
  options: AuthorityClientRuntimePathOptions = {}
): AuthorityClientRuntimePaths {
  const root = path.resolve(
    options.rootDirectory ?? path.join(os.homedir(), ".sompi", "authority")
  );
  const directory = path.resolve(
    options.clientDirectory ?? path.join(root, "client")
  );
  const runtimeDirectory = path.resolve(
    options.runtimeDirectory ?? path.join(root, "run")
  );
  if (
    directory === runtimeDirectory ||
    directory.startsWith(`${runtimeDirectory}${path.sep}`) ||
    runtimeDirectory.startsWith(`${directory}${path.sep}`)
  ) {
    throw new Error("authority client and runtime directories must be disjoint");
  }
  const socket = path.resolve(
    options.socketPath ?? path.join(runtimeDirectory, "authority.sock")
  );
  if (path.dirname(socket) !== runtimeDirectory) {
    throw new Error("authority socket must be directly contained by its runtime directory");
  }
  return Object.freeze({
    directory,
    macKey: path.join(directory, "ipc-mac.key"),
    trust: path.join(directory, "trust.json"),
    socket,
  });
}

/** The complete path set deliberately has no single shared credential directory. */
export function authorityRuntimePaths(
  options: AuthorityRuntimePathOptions = {}
): AuthorityRuntimePaths {
  const root = path.resolve(
    options.rootDirectory ?? path.join(os.homedir(), ".sompi", "authority")
  );
  const privateDirectory = path.resolve(
    options.privateDirectory ?? path.join(root, "private")
  );
  const clientDirectory = path.resolve(
    options.clientDirectory ?? path.join(root, "client")
  );
  const runtimeDirectory = path.resolve(
    options.runtimeDirectory ?? path.join(root, "run")
  );
  const callbackRuntimeDirectory = path.resolve(
    options.callbackRuntimeDirectory ?? path.join(root, "callback-run")
  );
  assertDisjointDirectories(
    privateDirectory,
    clientDirectory,
    runtimeDirectory,
    callbackRuntimeDirectory,
  );
  const client = authorityClientRuntimePaths({
    rootDirectory: root,
    clientDirectory,
    runtimeDirectory,
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
  });
  return Object.freeze({
    privateDirectory,
    clientDirectory,
    runtimeDirectory,
    callbackRuntimeDirectory,
    serverMacKey: path.join(privateDirectory, "ipc-mac.key"),
    clientMacKey: client.macKey,
    privateJwk: path.join(privateDirectory, "authority-private.jwk.json"),
    publicTrustEntry: path.join(clientDirectory, "authority-public-trust-entry.json"),
    serverTrust: path.join(privateDirectory, "trust.json"),
    clientTrust: client.trust,
    replayDatabase: path.join(privateDirectory, "replay.sqlite"),
    decisionDatabase: path.join(privateDirectory, "decisions.sqlite"),
    telegramBotToken: path.join(privateDirectory, "telegram-bot-token"),
    telegramPromptDatabase: path.join(privateDirectory, "telegram-prompts.sqlite"),
    socket: client.socket,
    telegramCallbackSocket: path.join(callbackRuntimeDirectory, "telegram-callback.sock"),
  });
}

export interface AuthorityIdentityConfig {
  readonly issuer: string;
  readonly kid: string;
  readonly keyId: string;
  readonly instrumentId: string;
}

export interface RunningAuthority {
  readonly paths: AuthorityRuntimePaths;
  close(): Promise<void>;
}

export interface AuthorityRuntimeAccessOptions {
  readonly socketGroupId?: number;
  readonly telegramCallbackSocketGroupId?: number;
  readonly admission?: AdmissionBudgetProjection;
  readonly authority?: OperatorManifest["authority"];
}

export async function initializeAuthorityRuntime(
  paths: AuthorityRuntimePaths,
  identity: Pick<AuthorityIdentityConfig, "issuer" | "kid">,
): Promise<Ap2PublicTrustEntry> {
  validateAuthorityRuntimePaths(paths);
  assertIdentity(identity.issuer, "authority issuer");
  assertIdentity(identity.kid, "authority key ID");
  for (const directory of [
    paths.privateDirectory,
    paths.clientDirectory,
    paths.runtimeDirectory,
    paths.callbackRuntimeDirectory,
  ]) {
    prepareEmptyDirectory(directory);
  }
  for (const filename of [
    paths.serverMacKey,
    paths.clientMacKey,
    paths.privateJwk,
    paths.publicTrustEntry,
    paths.serverTrust,
    paths.clientTrust,
  ]) {
    if (fs.existsSync(filename)) throw new Error("authority initialization refuses to overwrite existing files");
  }
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const exported = await exportJWK(privateKey);
  if (!exported.d || !exported.x || !exported.y || exported.kty !== "EC" || exported.crv !== "P-256") {
    throw new Error("authority key generation failed");
  }
  const privateJwk = {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: exported.x,
    y: exported.y,
    d: exported.d,
  };
  const publicJwk: P256PublicJwk = Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: exported.x,
    y: exported.y,
  });
  const trustEntry: Ap2PublicTrustEntry = Object.freeze({
    role: "authority",
    issuer: identity.issuer,
    kid: identity.kid,
    publicJwk,
  });
  const mac = randomBytes(AUTHORITY_MAC_KEY_BYTES);
  const created: string[] = [];
  try {
    writeExclusive(paths.serverMacKey, mac);
    created.push(paths.serverMacKey);
    writeExclusive(paths.clientMacKey, mac);
    created.push(paths.clientMacKey);
    writeExclusive(paths.privateJwk, Buffer.from(canonicalJson(privateJwk), "utf8"));
    created.push(paths.privateJwk);
    writeExclusive(paths.publicTrustEntry, Buffer.from(canonicalJson(trustEntry), "utf8"));
    created.push(paths.publicTrustEntry);
    writeExclusive(paths.serverTrust, Buffer.from(canonicalJson([trustEntry]), "utf8"));
    created.push(paths.serverTrust);
    writeExclusive(paths.clientTrust, Buffer.from(canonicalJson([trustEntry]), "utf8"));
    created.push(paths.clientTrust);
    fsyncDirectory(paths.privateDirectory);
    fsyncDirectory(paths.clientDirectory);
  } catch (error) {
    for (const filename of created.reverse()) {
      try {
        fs.unlinkSync(filename);
      } catch {
        // Preserve the initialization error; any remainder still fails closed.
      }
    }
    fsyncDirectory(paths.privateDirectory);
    fsyncDirectory(paths.clientDirectory);
    throw error;
  } finally {
    mac.fill(0);
  }
  return trustEntry;
}

export async function startAuthorityRuntime(
  paths: AuthorityRuntimePaths,
  identity: AuthorityIdentityConfig,
  access: AuthorityRuntimeAccessOptions = {},
): Promise<RunningAuthority> {
  if (!access.admission) {
    throw new Error("sompi-authority requires the Operator Manifest admission projection");
  }
  if (!access.authority) {
    throw new Error("sompi-authority requires the Operator Manifest Authority projection");
  }
  validateAuthorityRuntimePaths(paths);
  assertIdentity(identity.issuer, "authority issuer");
  assertIdentity(identity.kid, "authority signing key ID");
  assertIdentity(identity.keyId, "authority IPC key ID");
  assertIdentity(identity.instrumentId, "authority instrument ID");
  const signer = loadAuthoritySigningIdentity(paths.privateJwk, identity.issuer, identity.kid);
  const trust = loadAp2TrustStore(paths.serverTrust);
  const authentication = new AuthorityMacKeyFile(paths.serverMacKey, identity.keyId);
  const replay = new SqliteAuthorityReplayStore(paths.replayDatabase);
  const decisions = new SqliteAuthorityDecisionStore(paths.decisionDatabase);
  let prompt: AuthorityApprovalPrompt;
  let telegramStore: TelegramAuthorityPromptStore | undefined;
  let telegramBot: TelegramBotApi | undefined;
  let telegramPrompt: TelegramAuthorityApprovalPrompt | undefined;
  let telegramServer: RunningTelegramCallbackServer | undefined;
  if (access.authority.provider === "terminal") {
    prompt = new TerminalAuthorityApprovalPrompt({
      maxPrompts: access.admission.authorityPrompts,
    });
  } else {
    const telegram = access.authority.telegram;
    if (!telegram) throw new Error("Telegram Authority configuration is missing");
    telegramStore = new TelegramAuthorityPromptStore(paths.telegramPromptDatabase);
    telegramBot = new TelegramBotApi(paths.telegramBotToken, telegram);
    try {
      await telegramBot.verify();
      telegramPrompt = new TelegramAuthorityApprovalPrompt({
        config: telegram,
        store: telegramStore,
        bot: telegramBot,
      });
      telegramServer = await startTelegramCallbackServer({
        socketPath: paths.telegramCallbackSocket,
        ...(access.telegramCallbackSocketGroupId === undefined
          ? {}
          : { socketGroupId: access.telegramCallbackSocketGroupId }),
        maxConnections: access.admission.authorityPreauthSockets,
        handle: (input) => telegramPrompt!.resolveCallback(input),
      });
      prompt = telegramPrompt;
    } catch (error) {
      await telegramServer?.close();
      telegramPrompt?.close();
      telegramBot.close();
      telegramStore.close();
      throw error;
    }
  }
  const humanDecision = new Ap2HumanAuthorityDecisionProvider({
    signer,
    checkoutEvidenceVerifier: new KaspaX402AuthorityEvidenceVerifier(),
    instrumentId: identity.instrumentId,
    prompt,
  });
  const promptAdmission = new AuthorityPromptAdmission(access.admission.authorityPrompts);
  const service = new AuthorityService({
    replayStore: replay,
    decisionStore: decisions,
    authenticationProvider: authentication,
    humanDecision,
    promptAdmission,
  });
  const ownerDecisions = new OwnerAuthorityDecisionStore(`${paths.decisionDatabase}.owner`);
  const ownerService = new OwnerAuthorityService({
    authenticationProvider: authentication,
    signer,
    prompt,
    decisions: ownerDecisions,
    promptAdmission,
  });
  const server = new AuthorityUnixDecisionServer({
    socketPath: paths.socket,
    timeoutMs: AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
    ...(access.socketGroupId === undefined
      ? {}
      : { socketGroupId: access.socketGroupId }),
    ...(access.admission ? { admission: access.admission } : {}),
    endpoint: new AuthorityDecisionEndpoint({
      handleDecision: (wire, signal) => isOwnerAuthorityRequestWire(wire)
        ? ownerService.handleDecision(wire, signal)
        : service.handleDecision(wire, signal),
    }),
  });
  try {
    await server.start();
  } catch (error) {
    await telegramServer?.close();
    telegramPrompt?.close();
    telegramBot?.close();
    telegramStore?.close();
    replay.close();
    decisions.close();
    ownerDecisions.close();
    throw error;
  }
  let closed = false;
  return Object.freeze({
    paths,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      service.close();
      await telegramServer?.close();
      telegramPrompt?.close();
      telegramBot?.close();
      telegramStore?.close();
      replay.close();
      decisions.close();
      ownerDecisions.close();
    },
  });
}

function prepareEmptyDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  fs.chmodSync(directory, DIRECTORY_MODE);
  const stat = fs.lstatSync(directory);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o077) !== 0) {
    throw new Error("authority directory ownership or mode is invalid");
  }
}

function assertDisjointDirectories(...directories: string[]): void {
  for (let left = 0; left < directories.length; left++) {
    for (let right = left + 1; right < directories.length; right++) {
      const a = directories[left];
      const b = directories[right];
      if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) {
        throw new Error("authority private, client, and runtime directories must be disjoint");
      }
    }
  }
}

function validateAuthorityRuntimePaths(paths: AuthorityRuntimePaths): void {
  const keys = [
    "privateDirectory",
    "clientDirectory",
    "runtimeDirectory",
    "callbackRuntimeDirectory",
    "serverMacKey",
    "clientMacKey",
    "privateJwk",
    "publicTrustEntry",
    "serverTrust",
    "clientTrust",
    "replayDatabase",
    "decisionDatabase",
    "telegramBotToken",
    "telegramPromptDatabase",
    "socket",
    "telegramCallbackSocket",
  ] as const;
  if (
    !paths ||
    typeof paths !== "object" ||
    Object.keys(paths).sort().join("\0") !== [...keys].sort().join("\0") ||
    keys.some(
      (key) =>
        typeof paths[key] !== "string" ||
        paths[key].length === 0 ||
        path.resolve(paths[key]) !== paths[key]
    )
  ) {
    throw new Error("authority runtime paths are invalid");
  }
  const expected = authorityRuntimePaths({
    privateDirectory: paths.privateDirectory,
    clientDirectory: paths.clientDirectory,
    runtimeDirectory: paths.runtimeDirectory,
    callbackRuntimeDirectory: paths.callbackRuntimeDirectory,
    socketPath: paths.socket,
  });
  if (keys.some((key) => paths[key] !== expected[key])) {
    throw new Error("authority runtime paths are inconsistent");
  }
}

function writeExclusive(filename: string, bytes: Uint8Array): void {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
    FILE_MODE,
  );
  try {
    fs.fchmodSync(descriptor, FILE_MODE);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}
