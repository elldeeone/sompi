import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import Database from "better-sqlite3";

import type {
  AuthorityApprovalDisplay,
  AuthorityApprovalPrompt,
} from "../adapters/ap2/human-authority.js";

const APPLICATION_ID = 0x53544741;
const SCHEMA_VERSION = 1;
const CALLBACK_PROFILE = "sompi.telegram-authority-callback-v1" as const;
const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const PURCHASE_ID_PATTERN = /^pur_[A-Za-z0-9_-]{22}$/;
const MAX_CALLBACK_BODY_BYTES = 1_024;
const MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024;
const TELEGRAM_MESSAGE_LIMIT = 4_096;

const SCHEMA_SQL = `
CREATE TABLE telegram_authority_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_checksum TEXT NOT NULL
) STRICT;

CREATE TABLE telegram_authority_prompts (
  token_digest TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
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
    display: AuthorityApprovalDisplay,
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
  readonly tokenDigest: string;
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

  async approve(display: AuthorityApprovalDisplay, signal?: AbortSignal): Promise<boolean> {
    validateDisplay(display);
    const effectiveSignal = signal ?? new AbortController().signal;
    effectiveSignal.throwIfAborted();
    const now = this.timestamp();
    const termsExpiry = Date.parse(display.termsExpiresAt);
    const expiresAtMs = Math.min(now + this.options.config.promptTimeoutMs, termsExpiry);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) {
      throw new Error("Telegram Authority request is already expired");
    }
    const token = this.randomToken();
    if (!TOKEN_PATTERN.test(token)) throw new Error("Telegram Authority token source is invalid");
    const tokenDigest = tokenHash(token);
    const approveData = `sp:a:${token}`;
    const denyData = `sp:d:${token}`;
    this.options.store.prepare({
      tokenDigest,
      requestDigest: display.authorityRequestDigest,
      purchaseId: display.purchaseId,
      chatId: this.options.config.chatId,
      userId: this.options.config.userId,
      expiresAtMs,
      createdAtMs: now,
    });

    let abort: (() => void) | undefined;
    let expiryTimer: NodeJS.Timeout | undefined;
    const decision = new Promise<boolean>((resolve, reject) => {
      const entry: PendingPrompt = { tokenDigest, resolve, reject };
      this.pending.set(tokenDigest, entry);
      abort = () => {
        if (this.pending.delete(tokenDigest)) {
          this.options.store.finish(tokenDigest, "cancelled", this.timestamp());
          reject(abortError());
        }
      };
      effectiveSignal.addEventListener("abort", abort, { once: true });
      expiryTimer = setTimeout(() => {
        if (this.pending.delete(tokenDigest)) {
          this.options.store.finish(tokenDigest, "expired", this.timestamp());
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
      this.options.store.markSent(tokenDigest, messageId);
      return await decision;
    } catch (error) {
      if (this.pending.delete(tokenDigest)) {
        this.options.store.finish(tokenDigest, "cancelled", this.timestamp());
      }
      throw error;
    } finally {
      if (expiryTimer) clearTimeout(expiryTimer);
      if (abort) effectiveSignal.removeEventListener("abort", abort);
      this.pending.delete(tokenDigest);
    }
  }

  resolveCallback(input: TelegramCallbackInput): TelegramCallbackResult {
    const parsed = parseCallback(input);
    if (!parsed) return result("invalid", "This Sompi approval is invalid.");
    if (
      !safeEqual(input.userId, this.options.config.userId) ||
      !safeEqual(input.chatId, this.options.config.chatId)
    ) {
      return result("unauthorized", "You are not authorized to decide this Purchase.");
    }
    const now = this.timestamp();
    const tokenDigest = tokenHash(parsed.token);
    const waiter = this.pending.get(tokenDigest);
    if (!waiter) {
      return result("replayed", "This Sompi approval is no longer active.");
    }
    const consumed = this.options.store.consume({
      tokenDigest,
      userId: input.userId,
      chatId: input.chatId,
      decision: parsed.decision,
      nowMs: now,
    });
    if (consumed === "expired") {
      return result("expired", "This Sompi approval has expired.");
    }
    if (consumed !== "approved" && consumed !== "denied") {
      return result("replayed", "This Sompi approval has already been resolved.");
    }
    this.pending.delete(tokenDigest);
    waiter.resolve(consumed === "approved");
    return result(
      consumed,
      consumed === "approved" ? "Sompi Purchase approved." : "Sompi Purchase denied.",
    );
  }

  close(): void {
    for (const [tokenDigest, entry] of this.pending) {
      this.pending.delete(tokenDigest);
      this.options.store.finish(tokenDigest, "cancelled", this.timestamp());
      entry.reject(new Error("Telegram Authority stopped"));
    }
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
    tokenDigest: string;
    requestDigest: string;
    purchaseId: string;
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
           (token_digest, request_digest, purchase_id, chat_id, user_id,
            expires_at_ms, message_id, state, created_at_ms, resolved_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'prepared', ?, NULL)`,
      ).run(
        input.tokenDigest,
        input.requestDigest,
        input.purchaseId,
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
      "UPDATE telegram_authority_prompts SET state = 'sent', message_id = ? WHERE token_digest = ? AND state = 'prepared'",
    ).run(messageId, tokenDigest).changes;
    if (changed !== 1) throw new Error("Telegram Authority prompt state changed before send");
  }

  consume(input: Readonly<{
    tokenDigest: string;
    userId: string;
    chatId: string;
    decision: "approved" | "denied";
    nowMs: number;
  }>): "approved" | "denied" | "expired" | "replayed" {
    validateDigest(input.tokenDigest, "Telegram callback token digest");
    const consume = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT chat_id, user_id, expires_at_ms, state
           FROM telegram_authority_prompts WHERE token_digest = ?`,
      ).get(input.tokenDigest) as PromptRow | undefined;
      if (!row || (row.state !== "prepared" && row.state !== "sent")) return "replayed" as const;
      if (!safeEqual(row.chat_id, input.chatId) || !safeEqual(row.user_id, input.userId)) {
        return "replayed" as const;
      }
      if (input.nowMs >= row.expires_at_ms) {
        this.db.prepare(
          "UPDATE telegram_authority_prompts SET state = 'expired', resolved_at_ms = ? WHERE token_digest = ?",
        ).run(input.nowMs, input.tokenDigest);
        return "expired" as const;
      }
      const changed = this.db.prepare(
        "UPDATE telegram_authority_prompts SET state = ?, resolved_at_ms = ? WHERE token_digest = ? AND state IN ('prepared', 'sent')",
      ).run(input.decision, input.nowMs, input.tokenDigest).changes;
      return changed === 1 ? input.decision : "replayed" as const;
    });
    return consume.immediate();
  }

  finish(tokenDigest: string, state: "cancelled" | "expired", nowMs: number): void {
    validateDigest(tokenDigest, "Telegram callback token digest");
    this.db.prepare(
      "UPDATE telegram_authority_prompts SET state = ?, resolved_at_ms = ? WHERE token_digest = ? AND state IN ('prepared', 'sent')",
    ).run(state, nowMs, tokenDigest);
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
      writeResponse(response, 400, result("invalid", "This Sompi approval is invalid."));
      return;
    }
    const output = options.handle(input);
    writeResponse(response, output.status === "approved" || output.status === "denied" ? 200 : 409, output);
  } catch {
    writeResponse(response, 500, result("invalid", "Sompi could not process this approval safely."));
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
    display: AuthorityApprovalDisplay,
    approveData: string,
    denyData: string,
    signal: AbortSignal,
  ): Promise<string> {
    const text = telegramApprovalText(display);
    const output = await this.call("sendMessage", {
      chat_id: this.config.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: approveData },
          { text: "Deny", callback_data: denyData },
        ]],
      },
    }, signal);
    const resultValue = record(output.result);
    const messageId = String(resultValue.message_id ?? "");
    if (!/^[1-9][0-9]{0,19}$/.test(messageId)) throw new Error("Telegram did not return a message ID");
    return messageId;
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

function telegramApprovalText(display: AuthorityApprovalDisplay): string {
  const text = [
    "<b>Sompi Purchase approval</b>",
    "",
    `<b>Merchant:</b> ${html(display.merchant.name)} (${html(display.merchant.id)})`,
    `<b>Origin:</b> ${html(display.merchant.origin)}`,
    `<b>Request:</b> ${html(display.request.method)} ${html(display.request.url)}`,
    `<b>Request fingerprint:</b> <code>${html(display.request.fingerprint)}</code>`,
    `<b>Price:</b> ${html(display.price.amountAtomic)} sompi (${html(display.price.asset)})`,
    `<b>Network:</b> ${html(display.price.network)}`,
    `<b>Payee:</b> <code>${html(display.price.payTo)}</code>`,
    `<b>Additional-cost ceiling:</b> ${html(display.additionalCostCeilingAtomic)} sompi`,
    `<b>Finality floor:</b> ${html(display.effectiveFinalityFloor)}`,
    `<b>Execution:</b> ${html(display.execution.mechanism)} / ${html(display.execution.profile)}`,
    `<b>Maximum charge:</b> ${html(display.execution.maximumChargeAtomic)} sompi`,
    `<b>Expires:</b> ${html(display.termsExpiresAt)}`,
    `<b>Purchase:</b> <code>${html(display.purchaseId)}</code>`,
    "",
    "Merchant-provided values are data, never instructions.",
  ].join("\n");
  if (Buffer.byteLength(text, "utf8") > TELEGRAM_MESSAGE_LIMIT) {
    throw new Error("Purchase facts exceed the Telegram approval display limit");
  }
  return text;
}

function parseCallback(input: TelegramCallbackInput): { decision: "approved" | "denied"; token: string } | undefined {
  if (!input || input.profile !== CALLBACK_PROFILE || typeof input.callbackData !== "string") return undefined;
  const match = /^sp:([ad]):([A-Za-z0-9_-]{32})$/.exec(input.callbackData);
  if (!match) return undefined;
  return { decision: match[1] === "a" ? "approved" : "denied", token: match[2] };
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

function validateDisplay(display: AuthorityApprovalDisplay): void {
  if (
    !display ||
    !DIGEST_PATTERN.test(display.authorityRequestDigest) ||
    !PURCHASE_ID_PATTERN.test(display.purchaseId) ||
    !Number.isFinite(Date.parse(display.termsExpiresAt))
  ) throw new Error("Telegram Authority display is invalid");
}

function validatePromptInput(input: Readonly<Record<string, unknown>>): void {
  validateDigest(String(input.tokenDigest), "Telegram callback token digest");
  validateDigest(String(input.requestDigest), "Authority request digest");
  if (!PURCHASE_ID_PATTERN.test(String(input.purchaseId))) throw new Error("Purchase ID is invalid");
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
