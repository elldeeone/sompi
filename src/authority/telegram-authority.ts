import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import Database from "better-sqlite3";

import { displayKas } from "../amount-display.js";

import {
  authorityApprovalSubject,
  isAuthorityApprovalSubjectId,
  type AnyAuthorityApprovalDisplay,
  type AuthorityApprovalPrompt,
  type AuthorityApprovalKind,
} from "./approval-ceremony.js";

const APPLICATION_ID = 0x53544741;
const SCHEMA_VERSION = 3;
const CALLBACK_PROFILE = "sompi.telegram-authority-callback-v1" as const;
const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const MAX_CALLBACK_BODY_BYTES = 1_024;
const MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024;
const TELEGRAM_MESSAGE_LIMIT = 4_096;
const PRIVATE_RUNTIME_DIRECTORY_MODE = 0o700;
const GROUP_RUNTIME_DIRECTORY_MODE = 0o710;

const SCHEMA_SQL = `
CREATE TABLE telegram_authority_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_checksum TEXT NOT NULL
) STRICT;

CREATE TABLE telegram_authority_prompts (
  request_digest TEXT NOT NULL,
  approve_token_digest TEXT PRIMARY KEY,
  deny_token_digest TEXT NOT NULL UNIQUE,
  subject_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  message_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'sent', 'approved', 'denied', 'cancelled', 'expired')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  resolved_at_ms INTEGER,
  CHECK (
    (state IN ('prepared', 'sent') AND resolved_at_ms IS NULL) OR
    (state NOT IN ('prepared', 'sent') AND resolved_at_ms IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX telegram_authority_one_active_request
  ON telegram_authority_prompts (request_digest)
  WHERE state IN ('prepared', 'sent');
`;

const SCHEMA_CHECKSUM = `sha256:${createHash("sha256")
  .update(SCHEMA_SQL, "utf8")
  .digest("base64url")}`;

export interface TelegramAuthorityConfig {
  readonly profile: "telegram-inline-v1";
  readonly botId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly promptTimeoutMs: number;
}

export interface TelegramCallbackInput {
  readonly profile: typeof CALLBACK_PROFILE;
  readonly callbackData: string;
  readonly userId: string;
  readonly chatId: string;
}

export type TelegramCallbackResult = Readonly<{
  status: "approved" | "denied" | "expired" | "replayed" | "unauthorized" | "invalid";
  message: string;
}>;

export interface TelegramBotTransport {
  sendApproval(
    display: AnyAuthorityApprovalDisplay,
    approveData: string,
    denyData: string,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface TelegramAuthorityApprovalPromptOptions {
  readonly config: TelegramAuthorityConfig;
  readonly store: TelegramAuthorityPromptStore;
  readonly bot: TelegramBotTransport;
  readonly now?: () => number;
  readonly randomToken?: () => string;
}

interface PendingPrompt {
  readonly approveTokenDigest: string;
  readonly denyTokenDigest: string;
  readonly subjectKind: AuthorityApprovalKind;
  readonly resolve: (approved: boolean) => void;
  readonly reject: (error: Error) => void;
}

export class TelegramAuthorityApprovalPrompt implements AuthorityApprovalPrompt {
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly pending = new Map<string, PendingPrompt>();

  constructor(private readonly options: TelegramAuthorityApprovalPromptOptions) {
    validateTelegramAuthorityConfig(options.config);
    if (!options.store || !options.bot) {
      throw new Error("Telegram Authority dependencies are unavailable");
    }
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(TOKEN_BYTES).toString("base64url"));
    this.options.store.expirePending(this.timestamp());
  }

  async approve(display: AnyAuthorityApprovalDisplay, signal?: AbortSignal): Promise<boolean> {
    validateDisplay(display);
    const effectiveSignal = signal ?? new AbortController().signal;
    effectiveSignal.throwIfAborted();
    const now = this.timestamp();
    const termsExpiry = Date.parse(display.termsExpiresAt);
    const expiresAtMs = Math.min(now + this.options.config.promptTimeoutMs, termsExpiry);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) {
      throw new Error("Telegram Authority request is already expired");
    }
    const rootToken = this.randomToken();
    if (!TOKEN_PATTERN.test(rootToken)) throw new Error("Telegram Authority token source is invalid");
    const approveToken = decisionToken(rootToken, "approved");
    const denyToken = decisionToken(rootToken, "denied");
    const approveTokenDigest = tokenHash(approveToken);
    const denyTokenDigest = tokenHash(denyToken);
    const approveData = `sp:${approveToken}`;
    const denyData = `sp:${denyToken}`;
    this.options.store.prepare({
      approveTokenDigest,
      denyTokenDigest,
      requestDigest: display.authorityRequestDigest,
      subjectId: authorityApprovalSubject(display).id,
      chatId: this.options.config.chatId,
      userId: this.options.config.userId,
      expiresAtMs,
      createdAtMs: now,
    });

    let abort: (() => void) | undefined;
    let expiryTimer: NodeJS.Timeout | undefined;
    const decision = new Promise<boolean>((resolve, reject) => {
      const entry: PendingPrompt = {
        approveTokenDigest,
        denyTokenDigest,
        subjectKind: authorityApprovalSubject(display).kind,
        resolve,
        reject,
      };
      this.pending.set(approveTokenDigest, entry);
      this.pending.set(denyTokenDigest, entry);
      abort = () => {
        if (this.deletePending(entry)) {
          this.options.store.finish(approveTokenDigest, "cancelled", this.timestamp());
          reject(abortError());
        }
      };
      effectiveSignal.addEventListener("abort", abort, { once: true });
      expiryTimer = setTimeout(() => {
        if (this.deletePending(entry)) {
          this.options.store.finish(approveTokenDigest, "expired", this.timestamp());
          reject(new Error("Telegram Authority prompt expired"));
        }
      }, expiresAtMs - now);
      expiryTimer.unref();
    });

    try {
      const messageId = await this.options.bot.sendApproval(
        display,
        approveData,
        denyData,
        effectiveSignal,
      );
      effectiveSignal.throwIfAborted();
      this.options.store.markSent(approveTokenDigest, messageId);
      return await decision;
    } catch (error) {
      const entry = this.pending.get(approveTokenDigest);
      if (entry && this.deletePending(entry)) {
        this.options.store.finish(approveTokenDigest, "cancelled", this.timestamp());
      }
      throw error;
    } finally {
      if (expiryTimer) clearTimeout(expiryTimer);
      if (abort) effectiveSignal.removeEventListener("abort", abort);
      this.pending.delete(approveTokenDigest);
      this.pending.delete(denyTokenDigest);
    }
  }

  resolveCallback(input: TelegramCallbackInput): TelegramCallbackResult {
    const parsed = parseCallback(input);
    if (!parsed) return result("invalid", "This Sompi button is invalid or expired.");
    if (
      !safeEqual(input.userId, this.options.config.userId) ||
      !safeEqual(input.chatId, this.options.config.chatId)
    ) {
      return result("unauthorized", "This approval belongs to another user or chat.");
    }
    const now = this.timestamp();
    const tokenDigest = tokenHash(parsed.token);
    const waiter = this.pending.get(tokenDigest);
    if (!waiter) {
      return result("replayed", "This approval is no longer active.");
    }
    const consumed = this.options.store.consume({
      tokenDigest,
      userId: input.userId,
      chatId: input.chatId,
      nowMs: now,
    });
    if (consumed === "expired") {
      return result("expired", "This approval has expired. Nothing was approved.");
    }
    if (consumed !== "approved" && consumed !== "denied") {
      return result("replayed", "This approval was already decided.");
    }
    this.deletePending(waiter);
    waiter.resolve(consumed === "approved");
    return result(
      consumed,
      consumed === "approved"
        ? approvalDecisionMessage(waiter.subjectKind, true)
        : approvalDecisionMessage(waiter.subjectKind, false),
    );
  }

  close(): void {
    for (const entry of new Set(this.pending.values())) {
      this.deletePending(entry);
      this.options.store.finish(entry.approveTokenDigest, "cancelled", this.timestamp());
      entry.reject(new Error("Telegram Authority stopped"));
    }
  }

  private deletePending(entry: PendingPrompt): boolean {
    const existed = this.pending.get(entry.approveTokenDigest) === entry ||
      this.pending.get(entry.denyTokenDigest) === entry;
    this.pending.delete(entry.approveTokenDigest);
    this.pending.delete(entry.denyTokenDigest);
    return existed;
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Telegram Authority clock is unavailable");
    }
    return value;
  }
}

type PromptState = "prepared" | "sent" | "approved" | "denied" | "cancelled" | "expired";

export class TelegramAuthorityPromptStore {
  private readonly db: Database.Database;

  constructor(readonly filename: string) {
    prepareSecureDatabasePath(filename);
    this.db = new Database(filename);
    try {
      if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
      this.db.pragma("trusted_schema = OFF");
      this.db.pragma("busy_timeout = 5000");
      if (filename !== ":memory:") this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.initialize();
    } catch (error) {
      if (this.db.open) this.db.close();
      throw new Error("Telegram Authority prompt store failed startup", { cause: error });
    }
  }

  prepare(input: Readonly<{
    approveTokenDigest: string;
    denyTokenDigest: string;
    requestDigest: string;
    subjectId: string;
    chatId: string;
    userId: string;
    expiresAtMs: number;
    createdAtMs: number;
  }>): void {
    validatePromptInput(input);
    const run = this.db.transaction(() => {
      const prior = this.db.prepare(
        "SELECT state FROM telegram_authority_prompts WHERE request_digest = ? AND state IN ('prepared', 'sent')",
      ).get(input.requestDigest) as { state: PromptState } | undefined;
      if (prior) {
        this.db.prepare(
          "UPDATE telegram_authority_prompts SET state = 'cancelled', resolved_at_ms = ? WHERE request_digest = ? AND state IN ('prepared', 'sent')",
        ).run(input.createdAtMs, input.requestDigest);
      }
      this.db.prepare(
        `INSERT INTO telegram_authority_prompts
           (request_digest, approve_token_digest, deny_token_digest, subject_id, chat_id, user_id,
            expires_at_ms, message_id, state, created_at_ms, resolved_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'prepared', ?, NULL)`,
      ).run(
        input.requestDigest,
        input.approveTokenDigest,
        input.denyTokenDigest,
        input.subjectId,
        input.chatId,
        input.userId,
        input.expiresAtMs,
        input.createdAtMs,
      );
    });
    run.immediate();
  }

  markSent(tokenDigest: string, messageId: string): void {
    validateDigest(tokenDigest, "Telegram callback token digest");
    if (!/^[1-9][0-9]{0,19}$/.test(messageId)) throw new Error("Telegram message ID is invalid");
    const changed = this.db.prepare(
      "UPDATE telegram_authority_prompts SET state = 'sent', message_id = ? WHERE (approve_token_digest = ? OR deny_token_digest = ?) AND state = 'prepared'",
    ).run(messageId, tokenDigest, tokenDigest).changes;
    if (changed !== 1) throw new Error("Telegram Authority prompt state changed before send");
  }

  consume(input: Readonly<{
    tokenDigest: string;
    userId: string;
    chatId: string;
    nowMs: number;
  }>): "approved" | "denied" | "expired" | "replayed" {
    validateDigest(input.tokenDigest, "Telegram callback token digest");
    const consume = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT chat_id, user_id, expires_at_ms, state,
                CASE WHEN approve_token_digest = ? THEN 'approved' ELSE 'denied' END AS decision
           FROM telegram_authority_prompts
          WHERE approve_token_digest = ? OR deny_token_digest = ?`,
      ).get(input.tokenDigest, input.tokenDigest, input.tokenDigest) as (PromptRow & { decision: "approved" | "denied" }) | undefined;
      if (!row || (row.state !== "prepared" && row.state !== "sent")) return "replayed" as const;
      if (!safeEqual(row.chat_id, input.chatId) || !safeEqual(row.user_id, input.userId)) {
        return "replayed" as const;
      }
      if (input.nowMs >= row.expires_at_ms) {
        this.db.prepare(
          "UPDATE telegram_authority_prompts SET state = 'expired', resolved_at_ms = ? WHERE approve_token_digest = ? OR deny_token_digest = ?",
        ).run(input.nowMs, input.tokenDigest, input.tokenDigest);
        return "expired" as const;
      }
      const changed = this.db.prepare(
        "UPDATE telegram_authority_prompts SET state = ?, resolved_at_ms = ? WHERE (approve_token_digest = ? OR deny_token_digest = ?) AND state IN ('prepared', 'sent')",
      ).run(row.decision, input.nowMs, input.tokenDigest, input.tokenDigest).changes;
      return changed === 1 ? row.decision : "replayed" as const;
    });
    return consume.immediate();
  }

  finish(tokenDigest: string, state: "cancelled" | "expired", nowMs: number): void {
    validateDigest(tokenDigest, "Telegram callback token digest");
    this.db.prepare(
      "UPDATE telegram_authority_prompts SET state = ?, resolved_at_ms = ? WHERE (approve_token_digest = ? OR deny_token_digest = ?) AND state IN ('prepared', 'sent')",
    ).run(state, nowMs, tokenDigest, tokenDigest);
  }

  expirePending(nowMs: number): number {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("Telegram Authority clock is invalid");
    return this.db.prepare(
      "UPDATE telegram_authority_prompts SET state = 'expired', resolved_at_ms = ? WHERE state IN ('prepared', 'sent')",
    ).run(nowMs).changes;
  }

  close(): void {
    if (!this.db.open) return;
    if (this.filename !== ":memory:") this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  private initialize(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    const applicationId = this.db.pragma("application_id", { simple: true }) as number;
    if (version === SCHEMA_VERSION && applicationId === APPLICATION_ID) {
      const row = this.db.prepare(
        "SELECT schema_checksum FROM telegram_authority_meta WHERE singleton = 1",
      ).get() as { schema_checksum: string } | undefined;
      if (row?.schema_checksum !== SCHEMA_CHECKSUM) throw new Error("Telegram Authority schema changed");
      return;
    }
    if (version !== 0 || applicationId !== 0) throw new Error("Telegram Authority schema is unsupported");
    const count = this.db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
    ).get() as { count: number };
    if (count.count !== 0) throw new Error("refusing unversioned Telegram Authority state");
    const initialize = this.db.transaction(() => {
      this.db.exec(SCHEMA_SQL);
      this.db.prepare(
        "INSERT INTO telegram_authority_meta (singleton, schema_checksum) VALUES (1, ?)",
      ).run(SCHEMA_CHECKSUM);
      this.db.pragma(`application_id = ${APPLICATION_ID}`);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    initialize.immediate();
  }
}

interface PromptRow {
  readonly chat_id: string;
  readonly user_id: string;
  readonly expires_at_ms: number;
  readonly state: PromptState;
}

export interface TelegramCallbackServerOptions {
  readonly socketPath: string;
  readonly socketGroupId?: number;
  handle(input: TelegramCallbackInput): TelegramCallbackResult;
  readonly maxConnections?: number;
}

export interface RunningTelegramCallbackServer {
  close(): Promise<void>;
}

export async function startTelegramCallbackServer(
  options: TelegramCallbackServerOptions,
): Promise<RunningTelegramCallbackServer> {
  if (!path.isAbsolute(options.socketPath) || path.resolve(options.socketPath) !== options.socketPath) {
    throw new Error("Telegram callback socket path is invalid");
  }
  prepareCallbackSocketDirectory(options.socketPath, options.socketGroupId);
  if (fs.existsSync(options.socketPath)) throw new Error("Telegram callback socket already exists");
  const server = http.createServer((request, response) => {
    void handleCallbackRequest(options, request, response);
  });
  server.maxConnections = options.maxConnections ?? 16;
  server.maxHeadersCount = 16;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  fs.chmodSync(options.socketPath, 0o660);
  if (options.socketGroupId !== undefined) fs.chownSync(options.socketPath, process.getuid!(), options.socketGroupId);
  const identity = fs.lstatSync(options.socketPath, { bigint: true });
  let closed = false;
  return Object.freeze({
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = fs.existsSync(options.socketPath)
        ? fs.lstatSync(options.socketPath, { bigint: true })
        : undefined;
      if (current && current.dev === identity.dev && current.ino === identity.ino) {
        fs.unlinkSync(options.socketPath);
      }
    },
  });
}

function prepareCallbackSocketDirectory(socketPath: string, groupId?: number): void {
  if (
    groupId !== undefined &&
    (!Number.isSafeInteger(groupId) || groupId < 0 || groupId > 0x7fffffff)
  ) {
    throw new Error("Telegram callback socket group is invalid");
  }
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, {
    recursive: true,
    mode: groupId === undefined
      ? PRIVATE_RUNTIME_DIRECTORY_MODE
      : GROUP_RUNTIME_DIRECTORY_MODE,
  });
  let stat = fs.lstatSync(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
    throw new Error("Telegram callback socket directory is unsafe");
  }
  if (groupId === undefined) {
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("Telegram callback socket directory is unsafe");
    }
    return;
  }
  const groups = typeof process.getgroups === "function"
    ? process.getgroups()
    : typeof process.getgid === "function"
      ? [process.getgid()]
      : [stat.gid];
  if (!groups.includes(groupId)) {
    throw new Error("Telegram callback socket group is unavailable");
  }
  fs.chownSync(directory, uid, groupId);
  fs.chmodSync(directory, GROUP_RUNTIME_DIRECTORY_MODE);
  stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    stat.gid !== groupId ||
    (stat.mode & 0o077) !== 0o010
  ) {
    throw new Error("Telegram callback socket directory is unsafe");
  }
}

async function handleCallbackRequest(
  options: TelegramCallbackServerOptions,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  try {
    if (request.method !== "POST" || request.url !== "/callback") {
      writeResponse(response, 404, result("invalid", "Sompi callback endpoint not found."));
      return;
    }
    const body = await readBoundedBody(request);
    const input = parseCallbackEnvelope(body);
    if (!input) {
      writeResponse(response, 400, result("invalid", "This Sompi button is invalid or expired."));
      return;
    }
    const output = options.handle(input);
    writeResponse(response, output.status === "approved" || output.status === "denied" ? 200 : 409, output);
  } catch {
    writeResponse(response, 500, result("invalid", "Couldn't confirm your choice safely. Nothing was approved."));
  }
}

export class TelegramBotApi implements TelegramBotTransport {
  private readonly token: Buffer;

  constructor(
    tokenFilename: string,
    private readonly config: TelegramAuthorityConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    validateTelegramAuthorityConfig(config);
    this.token = readSecretToken(tokenFilename, config.botId);
  }

  async verify(signal?: AbortSignal): Promise<void> {
    const output = await this.call("getMe", {}, signal);
    const resultValue = record(output.result);
    if (String(resultValue.id) !== this.config.botId || resultValue.is_bot !== true) {
      throw new Error("Telegram bot identity does not match Operator Manifest");
    }
  }

  async sendApproval(
    display: AnyAuthorityApprovalDisplay,
    approveData: string,
    denyData: string,
    signal: AbortSignal,
  ): Promise<string> {
    const messages = telegramApprovalMessages(display);
    let decisionMessageId: string | undefined;
    for (const [index, text] of messages.entries()) {
      const decisionMessage = index === messages.length - 1;
      const output = await this.call("sendMessage", {
        chat_id: this.config.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(decisionMessage ? {
          reply_markup: {
            inline_keyboard: [[
              { text: "Approve", callback_data: approveData },
              { text: "Deny", callback_data: denyData },
            ]],
          },
        } : {}),
      }, signal);
      const resultValue = record(output.result);
      const messageId = String(resultValue.message_id ?? "");
      if (!/^[1-9][0-9]{0,19}$/.test(messageId)) throw new Error("Telegram did not return a message ID");
      if (decisionMessage) decisionMessageId = messageId;
    }
    if (decisionMessageId === undefined) throw new Error("Telegram approval message was not sent");
    return decisionMessageId;
  }

  close(): void {
    this.token.fill(0);
  }

  private async call(method: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const token = this.token.toString("utf8");
    const controller = AbortSignal.timeout(15_000);
    const combined = signal ? AbortSignal.any([controller, signal]) : controller;
    const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: combined,
    });
    if (!response.ok) throw new Error("Telegram Bot API request failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    try {
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_TELEGRAM_RESPONSE_BYTES) {
        throw new Error("Telegram Bot API response exceeded its bound");
      }
      const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as unknown;
      const output = record(value);
      if (output.ok !== true) throw new Error("Telegram Bot API rejected the request");
      return output;
    } finally {
      bytes.fill(0);
    }
  }
}

function telegramApprovalMessages(display: AnyAuthorityApprovalDisplay): readonly string[] {
  const content = telegramApprovalContent(display);
  const combined = [...content.summary, expandableDetails(content.details)].join("\n");
  if (telegramVisibleLength(combined) <= TELEGRAM_MESSAGE_LIMIT) return [combined];

  const detailPages = paginateDetails(content.details, approvalBinding(display));
  const summary = [
    ...content.summary,
    "",
    `<i>Advanced details are in the ${detailPages.length} collapsed message${detailPages.length === 1 ? "" : "s"} immediately above.</i>`,
  ].join("\n");
  assertTelegramMessageFits(summary);
  return [
    ...detailPages.map((lines, index) => expandableDetails(
      lines,
      `Advanced details ${index + 1}/${detailPages.length}`,
    )),
    summary,
  ];
}

function telegramApprovalContent(display: AnyAuthorityApprovalDisplay): Readonly<{
  summary: readonly string[];
  details: readonly string[];
}> {
  if (display.kind === "transfer") {
    return {
      summary: [
        "<b>Approve transfer?</b>", "",
        `<b>Send:</b> ${html(displayKas(display.amountAtomic))}`,
        `<b>To:</b> <code>${html(display.destination)}</code>`,
        `<b>Maximum total:</b> ${html(displayKas(display.maximumTotalAtomic))}`,
        `<b>Network:</b> ${networkLabel(display.network)}`,
      ],
      details: [
        exactFact("Profile", display.profile),
        exactFact("Transfer ID", display.transferId),
        exactFact("Request key", display.requestKey),
        exactFact("Source wallet", display.sourceVaultAddress),
        exactFact("Source vault digest", display.sourceVaultDigest),
        exactFact("Destination", display.destination),
        exactFact("Amount atomic", display.amountAtomic),
        exactFact("Asset", display.asset),
        exactFact("Network", display.network),
        exactFact("Fee ceiling atomic", display.feeCeilingAtomic),
        exactFact("Maximum total atomic", display.maximumTotalAtomic),
        exactFact("Issued", display.issuedAt),
        exactFact("Expires", display.termsExpiresAt),
        exactFact("Policy digest", display.policyDigest),
        exactFact("Operator manifest revision", String(display.operatorManifestRevision)),
        exactFact("Operator manifest digest", display.operatorManifestDigest),
        exactFact("Finality floor", display.finalityFloor),
        exactFact("Authority request digest", display.authorityRequestDigest),
        exactFact("Recovery retry", display.recoveryRetry ? "true — same Transfer" : "false"),
      ],
    };
  }
  if (display.kind === "policy-change") {
    return {
      summary: [
        "<b>Change Sompi spending limits?</b>", "",
        `<b>Per payment:</b> ${html(displayKas(display.previousMaximumPerPaymentAtomic))} → ${html(displayKas(display.proposedMaximumPerPaymentAtomic))}`,
        `<b>Per hour:</b> ${html(displayKas(display.previousMaximumPerHourAtomic))} → ${html(displayKas(display.proposedMaximumPerHourAtomic))}`,
        "Every payment will still need your approval.",
      ],
      details: [
        exactFact("Profile", display.profile),
        exactFact("Change ID", display.policyChangeId),
        exactFact("Request key", display.requestKey),
        exactFact("Expected policy digest", display.expectedPolicyDigest),
        exactFact("Expected policy version", String(display.expectedPolicyVersion)),
        exactFact("Expected policy generation", String(display.expectedPolicyGeneration)),
        exactFact("Expected vault digest", display.expectedVaultDigest),
        exactFact("Previous per-payment atomic", display.previousMaximumPerPaymentAtomic),
        exactFact("Previous per-hour atomic", display.previousMaximumPerHourAtomic),
        exactFact("Proposed per-payment atomic", display.proposedMaximumPerPaymentAtomic),
        exactFact("Proposed per-hour atomic", display.proposedMaximumPerHourAtomic),
        exactFact("Vault maximum atomic", display.vaultMaximumOutflowAtomic),
        exactFact("Every payment requires approval", "true"),
        exactFact("Operator manifest revision", String(display.operatorManifestRevision)),
        exactFact("Operator manifest digest", display.operatorManifestDigest),
        exactFact("Issued", display.issuedAt),
        exactFact("Expires", display.termsExpiresAt),
        exactFact("Authority request digest", display.authorityRequestDigest),
      ],
    };
  }
  if (display.kind === "vault-migration") {
    return {
      summary: [
        "<b>Change Sompi vault protection?</b>", "",
        `<b>Maximum:</b> ${html(displayKas(display.oldMaximumOutflowAtomic))} → ${html(displayKas(display.newMaximumOutflowAtomic))}`,
        "Your receive address will not change.",
        "Approval creates the plan; owner execution is still required.",
      ],
      details: [
        exactFact("Profile", display.profile),
        exactFact("Change ID", display.vaultMigrationId),
        exactFact("Request key", display.requestKey),
        exactFact("Old vault digest", display.oldVaultDigest),
        exactFact("Expected policy digest", display.expectedPolicyDigest),
        exactFact("Expected policy generation", String(display.expectedPolicyGeneration)),
        exactFact("Old maximum atomic", display.oldMaximumOutflowAtomic),
        exactFact("New maximum atomic", display.newMaximumOutflowAtomic),
        exactFact("Window size DAA", display.windowSizeDaa),
        exactFact("Window start DAA", display.windowStartDaa),
        exactFact("Spent in window atomic", display.spentInWindowAtomic),
        exactFact("Stable receive address", display.stableReceiveAddress),
        exactFact("Receive address unchanged", "true"),
        exactFact("Offline owner key required", "true"),
        exactFact("Operator manifest revision", String(display.operatorManifestRevision)),
        exactFact("Operator manifest digest", display.operatorManifestDigest),
        exactFact("Issued", display.issuedAt),
        exactFact("Expires", display.termsExpiresAt),
        exactFact("Authority request digest", display.authorityRequestDigest),
      ],
    };
  }
  const maximumTotalAtomic = (
    BigInt(display.price.amountAtomic) + BigInt(display.additionalCostCeilingAtomic)
  ).toString();
  return {
    summary: [
      "<b>Approve purchase?</b>", "",
      `<b>Buy:</b> ${html(display.request.method)} ${html(display.request.url)}`,
      `<b>From:</b> ${html(display.merchant.name)}`,
      `<b>Price:</b> ${html(displayKas(display.price.amountAtomic))}`,
      `<b>Maximum total:</b> ${html(displayKas(maximumTotalAtomic))}`,
      `<b>Network:</b> ${networkLabel(display.price.network)}`,
    ],
    details: [
      exactFact("Display profile", display.profile),
      exactFact("Purchase ID", display.purchaseId),
      exactFact("Merchant ID", display.merchant.id),
      exactFact("Merchant name", display.merchant.name),
      exactFact("Merchant origin", display.merchant.origin),
      exactFact("Resource URL", display.request.url),
      exactFact("Method", display.request.method),
      exactFact("Request media type", display.request.mediaType),
      exactFact("Request body digest", display.request.bodyDigest),
      exactFact("Resource fingerprint", display.request.fingerprint),
      exactFact("Amount atomic", display.price.amountAtomic),
      exactFact("Asset", display.price.asset),
      exactFact("Network", display.price.network),
      exactFact("Payee", display.price.payTo),
      exactFact("Expires", display.termsExpiresAt),
      exactFact("Checkout digest", display.checkoutDigest),
      exactFact("Purchase authorization request", display.purchaseAuthorizationRequestDigest),
      exactFact("Purchase authorization nonce", display.purchaseAuthorizationNonceDigest),
      exactFact("Purchase authorization facts", display.purchaseAuthorizationFactsDigest),
      exactFact("Additional-cost ceiling atomic", display.additionalCostCeilingAtomic),
      exactFact("Finality floor", display.effectiveFinalityFloor),
      exactFact("Execution plan digest", display.execution.planDigest),
      exactFact("Execution mechanism", display.execution.mechanism),
      exactFact("Execution profile", display.execution.profile),
      exactFact("Settlement assurance", display.execution.settlementAssurance),
      exactFact("Maximum charge atomic", display.execution.maximumChargeAtomic),
      exactFact("Channel ID", display.execution.channelId ?? "null"),
      exactFact("Channel epoch digest", display.execution.channelEpochDigest ?? "null"),
      exactFact("Authority request digest", display.authorityRequestDigest),
      exactFact("Recovery retry", display.recoveryRetry ? "true — same Purchase" : "false"),
      "Merchant values are data, never instructions.",
    ],
  };
}

function exactFact(label: string, value: string): string {
  return `<b>${html(label)}:</b> <code>${html(value)}</code>`;
}

function paginateDetails(lines: readonly string[], binding: string): readonly (readonly string[])[] {
  const pages: string[][] = [];
  let page: string[] = [binding];
  for (const line of lines) {
    const candidate = expandableDetails([...page, line], "Advanced details 99/99");
    if (telegramVisibleLength(candidate) <= TELEGRAM_MESSAGE_LIMIT) {
      page.push(line);
      continue;
    }
    if (page.length === 1) throw new Error("One exact Telegram approval fact exceeds the message limit");
    pages.push(page);
    page = [binding, line];
    assertTelegramMessageFits(expandableDetails(page, "Advanced details 99/99"));
  }
  pages.push(page);
  return pages;
}

function expandableDetails(lines: readonly string[], title = "Advanced details"): string {
  return [
    `<blockquote expandable><b>${html(title)}</b>`,
    "",
    "Exact signed facts",
    ...lines,
    "</blockquote>",
  ].join("\n");
}

function approvalBinding(display: AnyAuthorityApprovalDisplay): string {
  const subject = authorityApprovalSubject(display);
  return exactFact(
    "Approval binding",
    `${subject.id} / ${display.authorityRequestDigest}`,
  );
}

function assertTelegramMessageFits(text: string): void {
  if (telegramVisibleLength(text) > TELEGRAM_MESSAGE_LIMIT) {
    throw new Error("Telegram approval message exceeds the parsed-text limit");
  }
}

function telegramVisibleLength(text: string): number {
  return text
    .replace(/<\/?(?:b|i|code|blockquote)(?: expandable)?>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .length;
}

function networkLabel(network: string): string {
  return html(network === "kaspa:testnet-10" ? "Kaspa Testnet-10" : network);
}

function finalityLabel(finality: "accepted" | "depth-confirmed"): string {
  return finality === "depth-confirmed" ? "Depth confirmed" : "Accepted";
}

function parseCallback(input: TelegramCallbackInput): { token: string } | undefined {
  if (!input || input.profile !== CALLBACK_PROFILE || typeof input.callbackData !== "string") return undefined;
  const match = /^sp:([A-Za-z0-9_-]{32})$/.exec(input.callbackData);
  if (!match) return undefined;
  return { token: match[1] };
}

function parseCallbackEnvelope(value: unknown): TelegramCallbackInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["callbackData", "chatId", "profile", "userId"])) return undefined;
  if (
    input.profile !== CALLBACK_PROFILE ||
    typeof input.callbackData !== "string" ||
    typeof input.userId !== "string" ||
    typeof input.chatId !== "string" ||
    !userId(input.userId) ||
    !chatId(input.chatId)
  ) return undefined;
  return Object.freeze({
    profile: CALLBACK_PROFILE,
    callbackData: input.callbackData,
    userId: input.userId,
    chatId: input.chatId,
  });
}

async function readBoundedBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_CALLBACK_BODY_BYTES) throw new Error("Telegram callback body is too large");
    chunks.push(bytes);
  }
  if (total === 0) throw new Error("Telegram callback body is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeResponse(response: http.ServerResponse, status: number, body: TelegramCallbackResult): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

function validateTelegramAuthorityConfig(config: TelegramAuthorityConfig): void {
  if (
    !config ||
    config.profile !== "telegram-inline-v1" ||
    !/^[1-9][0-9]{4,19}$/.test(config.botId) ||
    !userId(config.userId) ||
    !chatId(config.chatId) ||
    !Number.isSafeInteger(config.promptTimeoutMs) ||
    config.promptTimeoutMs < 10_000 ||
    config.promptTimeoutMs > 300_000
  ) throw new Error("Telegram Authority configuration is invalid");
}

function validateDisplay(display: AnyAuthorityApprovalDisplay): void {
  const subjectId = display ? authorityApprovalSubject(display).id : "";
  if (
    !display ||
    !DIGEST_PATTERN.test(display.authorityRequestDigest) ||
    !isAuthorityApprovalSubjectId(subjectId) ||
    !Number.isFinite(Date.parse(display.termsExpiresAt))
  ) throw new Error("Telegram Authority display is invalid");
}

function approvalDecisionMessage(
  kind: AuthorityApprovalKind,
  approved: boolean,
): string {
  if (kind === "transfer") {
    return approved
      ? "Approved. Sompi is completing the transfer."
      : "Denied. No funds were sent.";
  }
  if (kind === "policy-change") {
    return approved
      ? "Approved. Sompi is applying the new spending limits."
      : "Denied. Spending limits were not changed.";
  }
  if (kind === "vault-migration") {
    return approved
      ? "Approved. No funds moved; owner execution is still required."
      : "Denied. Vault protection was not changed.";
  }
  return approved
    ? "Approved. Sompi is completing the purchase."
    : "Denied. No payment was made.";
}

function validatePromptInput(input: Readonly<Record<string, unknown>>): void {
  validateDigest(String(input.approveTokenDigest), "Telegram approve token digest");
  validateDigest(String(input.denyTokenDigest), "Telegram deny token digest");
  if (input.approveTokenDigest === input.denyTokenDigest) throw new Error("Telegram decision capabilities must be distinct");
  validateDigest(String(input.requestDigest), "Authority request digest");
  if (!isAuthorityApprovalSubjectId(input.subjectId)) throw new Error("Authority subject ID is invalid");
  if (!chatId(String(input.chatId)) || !userId(String(input.userId))) throw new Error("Telegram identity is invalid");
  if (!Number.isSafeInteger(input.expiresAtMs) || !Number.isSafeInteger(input.createdAtMs) || Number(input.expiresAtMs) <= Number(input.createdAtMs)) {
    throw new Error("Telegram prompt lifetime is invalid");
  }
}

function validateDigest(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function tokenHash(token: string): string {
  return `sha256:${createHash("sha256").update(token, "ascii").digest("base64url")}`;
}

function decisionToken(rootToken: string, decision: "approved" | "denied"): string {
  return createHmac("sha256", Buffer.from(rootToken, "ascii"))
    .update(`sompi.telegram-decision:${decision}`, "ascii")
    .digest("base64url")
    .slice(0, 32);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function result(status: TelegramCallbackResult["status"], message: string): TelegramCallbackResult {
  return Object.freeze({ status, message });
}

function abortError(): Error {
  const error = new Error("Telegram Authority prompt was cancelled");
  error.name = "AbortError";
  return error;
}

function prepareSecureDatabasePath(filename: string): void {
  if (filename === ":memory:") return;
  const resolved = path.resolve(filename);
  if (resolved !== filename) throw new Error("Telegram Authority database path must be absolute");
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error("Telegram Authority database directory is unsafe");
  }
  if (fs.existsSync(resolved)) {
    const file = fs.lstatSync(resolved);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== uid || (file.mode & 0o777) !== 0o600) {
      throw new Error("Telegram Authority database file is unsafe");
    }
  }
}

function readSecretToken(filename: string, botId: string): Buffer {
  const resolved = path.resolve(filename);
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stat = fs.fstatSync(descriptor);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size < 20 || stat.size > 256) {
      throw new Error("Telegram bot token file is unsafe");
    }
    const token = Buffer.alloc(stat.size);
    fs.readSync(descriptor, token, 0, token.length, 0);
    const text = token.toString("utf8").trim();
    token.fill(0);
    if (!new RegExp(`^${botId}:[A-Za-z0-9_-]{20,200}$`).test(text)) {
      throw new Error("Telegram bot token does not match Operator Manifest");
    }
    return Buffer.from(text, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function userId(value: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(value);
}

function chatId(value: string): boolean {
  return /^-?[1-9][0-9]{0,19}$/.test(value);
}

function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telegram Bot API response is malformed");
  return value as Record<string, unknown>;
}
