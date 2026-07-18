import * as fs from "node:fs";
import * as path from "node:path";

import {
  Ap2AuthorityDecisionEvidenceVerifier,
  Ap2AuthorityModule,
  loadAp2TrustStore,
} from "../adapters/ap2/index.js";
import { AuthorityUnixDecisionClient } from "../authority/endpoint.js";
import { AuthorityMacKeyFile } from "../authority/key-provider.js";
import { SqliteAuthorityReplayStore } from "../authority/replay-store.js";
import type { AuthorityClientRuntimePaths } from "../authority/runtime.js";
import { AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS } from "../authority/transport.js";
import {
  LOCAL_TESTNET_PROOF_PURCHASE_ID,
  runLocalTestnetProof,
  type LocalTestnetProofReport,
} from "./local-testnet-proof.js";

const DIRECTORY_MODE = 0o700;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const IPC_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export interface HumanPresentAuthorityProofOptions {
  readonly directory: string;
  readonly authority: Readonly<{
    readonly paths: AuthorityClientRuntimePaths;
    readonly expectedSocketOwnerUserId: number;
    readonly socketGroupId: number;
    readonly issuer: string;
    readonly keyId: string;
    readonly instrumentId: string;
  }>;
  readonly now?: () => number;
}

/**
 * MCP-side composition for the interactive authority proof. It can name only
 * the client MAC copy, public trust, replay state, and Unix socket; no signer
 * or authority-private path is accepted by this boundary.
 */
export async function runHumanPresentAuthorityProof(
  options: HumanPresentAuthorityProofOptions
): Promise<LocalTestnetProofReport> {
  validateOptions(options);
  const now = options.now ?? Date.now;
  const initialTime = now();
  if (!Number.isSafeInteger(initialTime) || initialTime <= 0) {
    throw new Error("human-present proof clock is unavailable");
  }
  const directory = secureOwnedDirectory(options.directory);
  assertDistinctProcessIdentity(
    options.authority.expectedSocketOwnerUserId,
    options.authority.socketGroupId
  );
  const trust = loadAp2TrustStore(options.authority.paths.trust);
  const replay = new SqliteAuthorityReplayStore(
    path.join(directory, "authority-client-replay.sqlite"),
    { now }
  );
  try {
    const module = new Ap2AuthorityModule({
      authenticationProvider: new AuthorityMacKeyFile(
        options.authority.paths.macKey,
        options.authority.keyId
      ),
      replayStore: replay,
      transport: new AuthorityUnixDecisionClient({
        socketPath: options.authority.paths.socket,
        timeoutMs: AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
        expectedSocketOwnerUserId:
          options.authority.expectedSocketOwnerUserId,
        socketGroupId: options.authority.socketGroupId,
      }),
      verifier: new Ap2AuthorityDecisionEvidenceVerifier({
        trust,
        expectedAuthorityIssuer: options.authority.issuer,
        expectedInstrumentId: options.authority.instrumentId,
        now,
        clockSkewSec: 0,
      }),
      now,
    });
    const report = await runLocalTestnetProof({
      directory: path.join(directory, "purchase"),
      keepDirectory: true,
      now,
      initiationMode: "mcp-sdk-in-memory-transport",
      externalAuthority: {
        module,
        trust,
        issuer: options.authority.issuer,
        instrumentId: options.authority.instrumentId,
        mode: "separate-process-human-present",
      },
    });
    if (
      report.authorityMode !== "separate-process-human-present" ||
      report.initiationMode !== "mcp-sdk-in-memory-transport" ||
      report.purchase.id !== LOCAL_TESTNET_PROOF_PURCHASE_ID ||
      report.purchase.state !== "receipted"
    ) {
      throw new Error("human-present proof result is inconsistent");
    }
    return report;
  } finally {
    replay.close();
  }
}

function validateOptions(options: HumanPresentAuthorityProofOptions): void {
  if (!options || typeof options !== "object") {
    throw new Error("human-present proof configuration is invalid");
  }
  const authority = options.authority;
  if (
    !authority ||
    typeof authority !== "object" ||
    !IDENTITY.test(authority.issuer) ||
    !IDENTITY.test(authority.instrumentId) ||
    !IPC_KEY_ID.test(authority.keyId) ||
    !validNumericId(authority.expectedSocketOwnerUserId) ||
    !validNumericId(authority.socketGroupId)
  ) {
    throw new Error("human-present authority client configuration is invalid");
  }
  const paths = authority.paths;
  if (
    !paths ||
    typeof paths !== "object" ||
    Object.values(paths).some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        !path.isAbsolute(value) ||
        path.resolve(value) !== value
    )
  ) {
    throw new Error("human-present authority client paths are invalid");
  }
  if (
    typeof options.directory !== "string" ||
    !path.isAbsolute(options.directory) ||
    path.resolve(options.directory) !== options.directory
  ) {
    throw new Error("human-present proof directory is invalid");
  }
}

function assertDistinctProcessIdentity(authorityUserId: number, socketGroupId: number): void {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgroups !== "function"
  ) {
    throw new Error("human-present proof requires Unix process identities");
  }
  const mcpUserId = process.getuid();
  if (mcpUserId === 0 || authorityUserId === 0 || mcpUserId === authorityUserId) {
    throw new Error("human-present proof requires distinct non-root authority and MCP users");
  }
  if (!process.getgroups().includes(socketGroupId)) {
    throw new Error("MCP process is not a member of the authority IPC group");
  }
}

function secureOwnedDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | directoryFlag() | noFollowFlag()
  );
  try {
    const stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(directory);
    const expectedUserId =
      typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (
      !stat.isDirectory() ||
      !pathStat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      stat.uid !== expectedUserId ||
      pathStat.uid !== expectedUserId ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino
    ) {
      throw new Error("human-present proof directory ownership is unsafe");
    }
    fs.fchmodSync(descriptor, DIRECTORY_MODE);
    if ((fs.fstatSync(descriptor).mode & 0o077) !== 0) {
      throw new Error("human-present proof directory mode is unsafe");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return directory;
}

function validNumericId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
}

function directoryFlag(): number {
  return typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}
