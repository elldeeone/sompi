import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { requestFingerprintFromBodyDigest } from "../purchase/identity.js";
import type { Sha256Digest } from "../purchase/types.js";
import type {
  AnyAuthorityApprovalDisplay,
  AuthorityApprovalDisplay,
  PolicyChangeAuthorityApprovalDisplay,
  TransferAuthorityApprovalDisplay,
  VaultMigrationAuthorityApprovalDisplay,
} from "./approval-ceremony.js";
import {
  TelegramAuthorityApprovalPrompt,
  TelegramAuthorityPromptStore,
  TelegramBotApi,
  startTelegramCallbackServer,
  type TelegramAuthorityConfig,
  type TelegramBotTransport,
  type TelegramCallbackInput,
} from "./telegram-authority.js";

const NOW = Date.parse("2026-07-18T05:00:00.000Z");
const TOKEN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CALLBACK_PROFILE = "sompi.telegram-authority-callback-v1" as const;
const CONFIG: TelegramAuthorityConfig = Object.freeze({
  profile: "telegram-inline-v1",
  botId: "8446058802",
  userId: "123456789",
  chatId: "123456789",
  promptTimeoutMs: 60_000,
});

test("Telegram Authority approves one exact prompt and rejects its replay", async (t) => {
  const fixture = createFixture(t, TOKEN_A);
  const pending = fixture.prompt.approve(display());
  await until(() => fixture.bot.sent.length === 1);
  const callback = envelope(fixture.bot.sent[0]!.approveData);

  assert.deepEqual(fixture.prompt.resolveCallback(callback), {
    status: "approved",
    message: "Approved. Sompi is completing the purchase.",
  });
  assert.equal(await pending, true);
  assert.equal(fixture.prompt.resolveCallback(callback).status, "replayed");
  assert.ok("merchant" in fixture.bot.sent[0]!.text);
  assert.match(fixture.bot.sent[0]!.text.merchant.name, /Merchant/);
});

test("Telegram Authority denies an exact prompt", async (t) => {
  const fixture = createFixture(t, TOKEN_A);
  const pending = fixture.prompt.approve(display());
  await until(() => fixture.bot.sent.length === 1);
  const denyData = fixture.bot.sent[0]!.denyData;
  const legacyDecisionSubstitution = denyData.replace(/^sp:/, "sp:a:");
  assert.equal(
    fixture.prompt.resolveCallback(envelope(legacyDecisionSubstitution)).status,
    "invalid",
    "the relay must not be able to turn a Deny capability into Approve",
  );
  assert.equal(
    fixture.prompt.resolveCallback(envelope(denyData)).status,
    "denied",
  );
  assert.equal(await pending, false);
});

test("Telegram Authority rejects a subject prefix from another ceremony", async (t) => {
  const fixture = createFixture(t, TOKEN_A);
  await assert.rejects(
    fixture.prompt.approve({
      ...transferDisplay(),
      transferId: "pur_AAAAAAAAAAAAAAAAAAAAAA",
    }),
    /does not match/,
  );
  assert.equal(fixture.bot.sent.length, 0);
});

test("Telegram Authority shows and resolves exact direct-Transfer facts", async (t) => {
  const fixture = createFixture(t, TOKEN_A);
  const pending = fixture.prompt.approve(transferDisplay());
  await until(() => fixture.bot.sent.length === 1);
  const sent = fixture.bot.sent[0]!;
  assert.equal(sent.text.kind, "transfer");
  assert.equal(fixture.prompt.resolveCallback(envelope(sent.approveData)).message, "Approved. Sompi is completing the transfer.");
  assert.equal(await pending, true);
});

test("Telegram Authority clearly separates vault approval from offline owner execution", async (t) => {
  const fixture = createFixture(t, TOKEN_A);
  const pending = fixture.prompt.approve(vaultMigrationDisplay());
  await until(() => fixture.bot.sent.length === 1);
  const sent = fixture.bot.sent[0]!;
  assert.equal(sent.text.kind, "vault-migration");
  assert.equal(fixture.prompt.resolveCallback(envelope(sent.approveData)).message, "Approved. No funds moved; owner execution is still required.");
  assert.equal(await pending, true);
});

test("Telegram Authority binds callbacks to the configured Telegram user and chat", async (t) => {
  const fixture = createFixture(t, TOKEN_A);
  const pending = fixture.prompt.approve(display());
  await until(() => fixture.bot.sent.length === 1);
  const approveData = fixture.bot.sent[0]!.approveData;

  assert.equal(
    fixture.prompt.resolveCallback({ ...envelope(approveData), userId: "987654321" }).status,
    "unauthorized",
  );
  assert.equal(
    fixture.prompt.resolveCallback({ ...envelope(approveData), chatId: "-100123456789" }).status,
    "unauthorized",
  );
  assert.equal(fixture.prompt.resolveCallback(envelope(approveData)).status, "approved");
  assert.equal(await pending, true);
});

test("Telegram Authority expires prompts and never restores them after restart", async (t) => {
  const directory = temporaryDirectory(t);
  const filename = path.join(directory, "prompts.sqlite");
  const bot = new FakeBot();
  const firstStore = new TelegramAuthorityPromptStore(filename);
  const first = new TelegramAuthorityApprovalPrompt({
    config: CONFIG,
    store: firstStore,
    bot,
    now: () => NOW,
    randomToken: () => TOKEN_A,
  });
  const pending = first.approve(display());
  await until(() => bot.sent.length === 1);
  const firstApproveData = bot.sent[0]!.approveData;
  first.close();
  await assert.rejects(pending, /stopped/);
  firstStore.close();

  const secondStore = new TelegramAuthorityPromptStore(filename);
  const second = new TelegramAuthorityApprovalPrompt({
    config: CONFIG,
    store: secondStore,
    bot,
    now: () => NOW + 1_000,
    randomToken: () => TOKEN_B,
  });
  t.after(() => {
    second.close();
    secondStore.close();
  });
  assert.equal(second.resolveCallback(envelope(firstApproveData)).status, "replayed");
});

test("Telegram Authority permits a safe retry after a transport failure", async (t) => {
  const directory = temporaryDirectory(t);
  const store = new TelegramAuthorityPromptStore(path.join(directory, "prompts.sqlite"));
  let attempt = 0;
  let activeApproveData: string | undefined;
  const bot: TelegramBotTransport = {
    async sendApproval(_display, approveData) {
      attempt += 1;
      if (attempt === 1) throw new Error("Telegram unavailable");
      activeApproveData = approveData;
      return "2";
    },
  };
  const tokens = [TOKEN_A, TOKEN_B];
  const prompt = new TelegramAuthorityApprovalPrompt({
    config: CONFIG,
    store,
    bot,
    now: () => NOW,
    randomToken: () => tokens.shift()!,
  });
  t.after(() => {
    prompt.close();
    store.close();
  });
  await assert.rejects(prompt.approve(display()), /Telegram unavailable/);
  const pending = prompt.approve(display());
  await until(() => attempt === 2);
  assert.equal(typeof activeApproveData, "string");
  assert.equal(prompt.resolveCallback(envelope(activeApproveData!)).status, "approved");
  assert.equal(await pending, true);
});

test("Telegram callback server accepts only its bounded exact envelope", async (t) => {
  const directory = temporaryDirectory(t);
  const socketPath = path.join(directory, "callback.sock");
  const seen: TelegramCallbackInput[] = [];
  const server = await startTelegramCallbackServer({
    socketPath,
    handle(input) {
      seen.push(input);
      return { status: "approved", message: "ok" };
    },
  });
  t.after(() => server.close());

  const valid = await unixRequest(socketPath, JSON.stringify(envelope(`sp:${TOKEN_A}`)));
  assert.equal(valid.status, 200);
  assert.equal(seen.length, 1);
  const extra = await unixRequest(socketPath, JSON.stringify({
    ...envelope(`sp:${TOKEN_A}`),
    extra: true,
  }));
  assert.equal(extra.status, 400);
  const oversized = await unixRequest(socketPath, JSON.stringify({ value: "x".repeat(2_000) }));
  assert.equal(oversized.status, 500);
  assert.equal(seen.length, 1);
});

test("Telegram callback server makes a shared callback directory traversable by its pinned group", async (t) => {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  ) {
    return;
  }
  const directory = temporaryDirectory(t);
  const socketPath = path.join(directory, "callback.sock");
  const groupId = process.getgid();
  const server = await startTelegramCallbackServer({
    socketPath,
    socketGroupId: groupId,
    handle() {
      return { status: "approved", message: "ok" };
    },
  });
  t.after(() => server.close());

  const runtime = fs.lstatSync(directory);
  assert.equal(runtime.uid, process.getuid());
  assert.equal(runtime.gid, groupId);
  assert.equal(runtime.mode & 0o777, 0o710);
  const socket = fs.lstatSync(socketPath);
  assert.equal(socket.uid, process.getuid());
  assert.equal(socket.gid, groupId);
  assert.equal(socket.mode & 0o777, 0o660);
  assert.equal(
    (await unixRequest(socketPath, JSON.stringify(envelope(`sp:${TOKEN_A}`)))).status,
    200,
  );
});

test("Telegram Bot API sends concise escaped facts with native expandable details", async (t) => {
  const directory = temporaryDirectory(t);
  const tokenFile = path.join(directory, "telegram-bot-token");
  fs.writeFileSync(tokenFile, `${CONFIG.botId}:${"A".repeat(40)}\n`, { mode: 0o600 });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const method = String(input).split("/").at(-1);
    return new Response(JSON.stringify(method === "getMe"
      ? { ok: true, result: { id: Number(CONFIG.botId), is_bot: true } }
      : { ok: true, result: { message_id: 42 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const bot = new TelegramBotApi(tokenFile, CONFIG, fetcher);
  t.after(() => bot.close());
  await bot.verify();
  const hostile = Object.freeze({
    ...display(),
    merchant: Object.freeze({ ...display().merchant, name: "<Admin> & merchant" }),
  });
  assert.equal(await bot.sendApproval(hostile, `sp:a:${TOKEN_A}`, `sp:d:${TOKEN_A}`, new AbortController().signal), "42");
  assert.equal(calls.length, 2);
  assert.match(String(calls[1]!.body.text), /&lt;Admin&gt; &amp; merchant/);
  assert.match(String(calls[1]!.body.text), /^<b>Approve purchase\?<\/b>/);
  assert.match(String(calls[1]!.body.text), /<blockquote expandable><b>Advanced details<\/b>/);
  assert.match(String(calls[1]!.body.text), /<b>Maximum total:<\/b> 0\.000011 tKAS/);
  assert.deepEqual(calls[1]!.body.reply_markup, {
    inline_keyboard: [[
      { text: "Approve", callback_data: `sp:a:${TOKEN_A}` },
      { text: "Deny", callback_data: `sp:d:${TOKEN_A}` },
    ]],
  });
});

test("all Telegram approval kinds lead with simple decision facts and retain advanced evidence", async (t) => {
  const directory = temporaryDirectory(t);
  const tokenFile = path.join(directory, "telegram-bot-token");
  fs.writeFileSync(tokenFile, `${CONFIG.botId}:${"A".repeat(40)}\n`, { mode: 0o600 });
  const messages: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const method = String(input).split("/").at(-1);
    if (method === "sendMessage") {
      const body = JSON.parse(String(init?.body)) as { text: string };
      messages.push(body.text);
    }
    return new Response(JSON.stringify(method === "getMe"
      ? { ok: true, result: { id: Number(CONFIG.botId), is_bot: true } }
      : { ok: true, result: { message_id: messages.length } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const bot = new TelegramBotApi(tokenFile, CONFIG, fetcher);
  t.after(() => bot.close());

  await bot.sendApproval(transferDisplay(), `sp:${TOKEN_A}`, `sp:${TOKEN_B}`, new AbortController().signal);
  await bot.sendApproval(policyChangeDisplay(), `sp:${TOKEN_A}`, `sp:${TOKEN_B}`, new AbortController().signal);
  await bot.sendApproval(vaultMigrationDisplay(), `sp:${TOKEN_A}`, `sp:${TOKEN_B}`, new AbortController().signal);

  assert.match(messages[0]!, /^<b>Approve transfer\?<\/b>/);
  assert.match(messages[0]!, /<b>Send:<\/b> 0\.2 tKAS/);
  assert.match(messages[0]!, /<b>Source wallet:<\/b>/);
  assert.match(messages[1]!, /^<b>Change Sompi spending limits\?<\/b>/);
  assert.match(messages[1]!, /0\.1 tKAS → 0\.2 tKAS/);
  assert.match(messages[1]!, /Expected policy generation:<\/b> <code>2<\/code>/);
  assert.match(messages[1]!, /Expected vault digest:<\/b> <code>sha256:BBBB/);
  assert.match(messages[2]!, /^<b>Change Sompi vault protection\?<\/b>/);
  assert.match(messages[2]!, /owner execution is still required/);
  assert.match(messages[2]!, /Window size DAA:<\/b> <code>36000<\/code>/);
  assert.match(messages[2]!, /Spent in window atomic:<\/b> <code>100000000<\/code>/);
  assert.match(messages[2]!, /Stable receive address:<\/b> <code>kaspatest:/);
  for (const message of messages) {
    assert.match(message, /<blockquote expandable><b>Advanced details<\/b>/);
  }
});

test("maximum contract-shaped Purchase facts are paginated before the decision card", async (t) => {
  const directory = temporaryDirectory(t);
  const tokenFile = path.join(directory, "telegram-bot-token");
  fs.writeFileSync(tokenFile, `${CONFIG.botId}:${"A".repeat(40)}\n`, { mode: 0o600 });
  const calls: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const bot = new TelegramBotApi(tokenFile, CONFIG, fetcher);
  t.after(() => bot.close());
  const urlPrefix = "https://merchant.example/";
  const resourceUrl = `${urlPrefix}${"a".repeat(2_048 - urlPrefix.length)}`;
  const mediaType = `application/${"a".repeat(188)}`;
  const bodyDigest = display().request.bodyDigest as Sha256Digest;
  const maximum = Object.freeze({
    ...display(),
    merchant: Object.freeze({
      ...display().merchant,
      id: "m".repeat(160),
      name: "&".repeat(160),
    }),
    request: Object.freeze({
      ...display().request,
      url: resourceUrl,
      mediaType,
      fingerprint: requestFingerprintFromBodyDigest({
        method: "GET",
        url: resourceUrl,
        mediaType,
        bodyDigest,
      }),
    }),
    execution: Object.freeze({
      ...display().execution,
      profile: "kaspa-escrow-v1:batch-settlement",
      mechanism: "channel-voucher" as const,
      settlementAssurance: "channel-commitment" as const,
      channelId: "c".repeat(160),
      channelEpochDigest: "sha256:IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII",
    }),
  }) satisfies AuthorityApprovalDisplay;

  assert.equal(
    await bot.sendApproval(maximum, `sp:${TOKEN_A}`, `sp:${TOKEN_B}`, new AbortController().signal),
    String(calls.length),
  );
  assert.ok(calls.length > 1, "maximum accepted facts must use multiple bounded messages");
  for (const call of calls) {
    assert.ok(parsedTelegramLength(String(call.text)) <= 4_096);
  }
  for (const call of calls.slice(0, -1)) {
    assert.equal(call.reply_markup, undefined, "detail pages cannot carry decision capabilities");
    assert.match(String(call.text), /^<blockquote expandable>/);
    assert.match(String(call.text), new RegExp(maximum.authorityRequestDigest));
  }
  const decision = calls.at(-1)!;
  assert.match(String(decision.text), /^<b>Approve purchase\?<\/b>/);
  assert.deepEqual(decision.reply_markup, {
    inline_keyboard: [[
      { text: "Approve", callback_data: `sp:${TOKEN_A}` },
      { text: "Deny", callback_data: `sp:${TOKEN_B}` },
    ]],
  });
  const completeDisplay = calls.map((call) => String(call.text)).join("\n");
  assert.match(completeDisplay, /Purchase authorization request:<\/b>/);
  assert.match(completeDisplay, /Purchase authorization nonce:<\/b>/);
  assert.match(completeDisplay, /Merchant settlement assurance:<\/b>/);
  assert.match(completeDisplay, /Sompi operator floor:<\/b>/);
  assert.match(completeDisplay, /Effective finality floor:<\/b>/);
  assert.match(completeDisplay, /Depth-confirmed minimum DAA depth:<\/b>/);
  assert.match(completeDisplay, /Purchase authorization facts:<\/b>/);
  assert.match(completeDisplay, new RegExp("&amp;".repeat(8)));
});

class FakeBot implements TelegramBotTransport {
  readonly sent: Array<{
    text: AnyAuthorityApprovalDisplay;
    approveData: string;
    denyData: string;
  }> = [];

  async sendApproval(
    text: AnyAuthorityApprovalDisplay,
    approveData: string,
    denyData: string,
  ): Promise<string> {
    this.sent.push({ text, approveData, denyData });
    return String(this.sent.length);
  }
}

function createFixture(t: test.TestContext, token: string) {
  const directory = temporaryDirectory(t);
  const store = new TelegramAuthorityPromptStore(path.join(directory, "prompts.sqlite"));
  const bot = new FakeBot();
  const prompt = new TelegramAuthorityApprovalPrompt({
    config: CONFIG,
    store,
    bot,
    now: () => NOW,
    randomToken: () => token,
  });
  t.after(() => {
    prompt.close();
    store.close();
  });
  return { prompt, store, bot };
}

function temporaryDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-telegram-authority-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function envelope(callbackData: string): TelegramCallbackInput {
  return Object.freeze({
    profile: CALLBACK_PROFILE,
    callbackData,
    userId: CONFIG.userId,
    chatId: CONFIG.chatId,
  });
}

function display(): AuthorityApprovalDisplay {
  return Object.freeze({
    profile: "sompi.purchase-approval.2",
    authorityRequestDigest: "sha256:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    purchaseId: "pur_AAAAAAAAAAAAAAAAAAAAAA",
    merchant: Object.freeze({
      id: "https://merchant.example",
      name: "Merchant",
      origin: "https://merchant.example",
    }),
    request: Object.freeze({
      url: "https://merchant.example/resource",
      method: "GET",
      mediaType: "application/octet-stream",
      bodyDigest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      fingerprint: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    }),
    price: Object.freeze({
      amountAtomic: "1000",
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    }),
    checkoutDigest: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    purchaseAuthorizationRequestDigest: "sha256:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    purchaseAuthorizationNonceDigest: "sha256:GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    purchaseAuthorizationFactsDigest: "sha256:HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH",
    termsExpiresAt: "2026-07-18T05:05:00.000Z",
    additionalCostCeilingAtomic: "100",
    operatorFinalityFloor: "accepted",
    effectiveFinalityFloor: "accepted",
    depthConfirmationDaa: "10",
    execution: Object.freeze({
      planDigest: "sha256:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      mechanism: "single-transaction",
      profile: "kaspa-exact-v2:standard-native",
      settlementAssurance: "accepted",
      maximumChargeAtomic: "1000",
      channelId: null,
      channelEpochDigest: null,
    }),
    recoveryRetry: false,
  });
}

function transferDisplay(): TransferAuthorityApprovalDisplay {
  return Object.freeze({
    kind: "transfer",
    profile: "sompi.transfer.1",
    authorityRequestDigest: "sha256:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    transferId: "trf_AAAAAAAAAAAAAAAAAAAAAA",
    requestKey: "send:one",
    sourceVaultAddress: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    sourceVaultDigest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    destination: "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd",
    amountAtomic: "20000000",
    asset: "KAS",
    network: "kaspa:testnet-10",
    feeCeilingAtomic: "2500000",
    maximumTotalAtomic: "22500000",
    issuedAt: "2026-07-18T04:59:00.000Z",
    termsExpiresAt: "2026-07-18T05:01:00.000Z",
    policyDigest: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    operatorManifestRevision: 1,
    operatorManifestDigest: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    finalityFloor: "accepted",
    recoveryRetry: false,
  });
}

function policyChangeDisplay(): PolicyChangeAuthorityApprovalDisplay {
  return Object.freeze({
    kind: "policy-change",
    profile: "sompi.policy-change.1",
    authorityRequestDigest: "sha256:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    policyChangeId: "pcg_AAAAAAAAAAAAAAAAAAAAAA",
    requestKey: "limits:one",
    expectedPolicyDigest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expectedPolicyVersion: 1,
    expectedPolicyGeneration: 2,
    expectedVaultDigest: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    previousMaximumPerPaymentAtomic: "10000000",
    previousMaximumPerHourAtomic: "50000000",
    proposedMaximumPerPaymentAtomic: "20000000",
    proposedMaximumPerHourAtomic: "100000000",
    vaultMaximumOutflowAtomic: "500000000",
    everyPaymentRequiresApproval: true,
    issuedAt: "2026-07-18T04:59:00.000Z",
    termsExpiresAt: "2026-07-18T05:01:00.000Z",
    operatorManifestRevision: 1,
    operatorManifestDigest: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  });
}

function vaultMigrationDisplay(): VaultMigrationAuthorityApprovalDisplay {
  return Object.freeze({
    kind: "vault-migration",
    profile: "sompi.vault-migration.1",
    authorityRequestDigest: "sha256:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    vaultMigrationId: "vmg_AAAAAAAAAAAAAAAAAAAAAA",
    requestKey: "vault:protection:one",
    oldVaultDigest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expectedPolicyDigest: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    expectedPolicyGeneration: 2,
    oldMaximumOutflowAtomic: "500000000",
    newMaximumOutflowAtomic: "1000000000",
    windowSizeDaa: "36000",
    windowStartDaa: "123000",
    spentInWindowAtomic: "100000000",
    stableReceiveAddress: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    stableReceiveAddressWillNotChange: true,
    requiresOfflineOwnerKey: true,
    issuedAt: "2026-07-18T04:59:00.000Z",
    termsExpiresAt: "2026-07-18T05:01:00.000Z",
    operatorManifestRevision: 1,
    operatorManifestDigest: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  });
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Telegram Authority test timed out");
}

function parsedTelegramLength(text: string): number {
  return text
    .replace(/<\/?(?:b|i|code|blockquote)(?: expandable)?>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .length;
}

async function unixRequest(socketPath: string, body: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: "/callback",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
