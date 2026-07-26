import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AuthorityPromptBusyError,
  TerminalAuthorityApprovalPrompt,
} from "./terminal-authority.js";
import type { AuthorityApprovalDisplay } from "./approval-ceremony.js";

test("terminal authority rejects piped approval input by default", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompt = new TerminalAuthorityApprovalPrompt({ input, output });
  await assert.rejects(
    prompt.approve(display("pur_ZZZZZZZZZZZZZZZZZZZZZZ")),
    /requires a trusted terminal/
  );
  input.end();
  output.end();
});

test("terminal authority rejects a subject prefix that does not match its ceremony", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompt = new TerminalAuthorityApprovalPrompt({
    input,
    output,
    allowNonTtyForTests: true,
  });
  await assert.rejects(
    prompt.approve(display("trf_AAAAAAAAAAAAAAAAAAAAAA")),
    /does not match/,
  );
  assert.equal(prompt.pendingCount(), 0);
  input.end();
  output.end();
});

test("terminal authority serializes concurrent Purchase ceremonies", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let rendered = "";
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });
  const prompt = new TerminalAuthorityApprovalPrompt({
    input,
    output,
    allowNonTtyForTests: true,
  });
  const first = display("pur_AAAAAAAAAAAAAAAAAAAAAA");
  const second = display("pur_BBBBBBBBBBBBBBBBBBBBBB");

  const firstDecision = prompt.approve(first);
  const secondDecision = prompt.approve(second);
  await until(() => rendered.includes(first.purchaseId));
  assert.equal(rendered.includes(second.purchaseId), false);

  input.write(`${first.purchaseId}\n`);
  assert.equal(await firstDecision, true);
  await until(() => rendered.includes(second.purchaseId));
  input.write(`${second.purchaseId}\n`);
  assert.equal(await secondDecision, true);
  input.end();
  output.end();
});

test("terminal authority renders hostile Merchant text only as escaped data", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let rendered = "";
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });
  const prompt = new TerminalAuthorityApprovalPrompt({
    input,
    output,
    allowNonTtyForTests: true,
  });
  const canonical = display("pur_CCCCCCCCCCCCCCCCCCCCCC");
  const hostile: AuthorityApprovalDisplay = Object.freeze({
    ...canonical,
    merchant: Object.freeze({
      ...canonical.merchant,
      name: "Merchant\u001b]0;FAKE APPROVAL\u0007\n\"amountAtomic\":\"0\"\u202e",
    }),
    request: Object.freeze({
      ...canonical.request,
      url: `${canonical.request.url}\r\nFAKE EXPIRY: never`,
    }),
  });

  const decision = prompt.approve(hostile);
  await until(() => rendered.includes("anything else denies"));

  assert.equal(rendered.includes("\u001b"), false, "raw ANSI escape must not reach the terminal");
  assert.equal(rendered.includes("\u0007"), false, "raw terminal bell must not reach the terminal");
  assert.equal(rendered.includes("\u202e"), false, "raw bidi override must not reach the terminal");
  assert.equal(rendered.includes("\r"), false, "raw carriage return must not reach the terminal");
  for (const escaped of ["\\\\u001b", "\\\\u0007", "\\\\u000a", "\\\\u202e", "\\\\u000d"]) {
    assert.equal(rendered.includes(escaped), true, `missing escaped terminal data ${escaped}`);
  }
  assert.equal(rendered.includes('"amountAtomic": "1000"'), true);
  assert.equal(
    rendered.includes('"termsExpiresAt": "2099-01-01T00:00:00.000Z"'),
    true,
  );
  assert.equal(rendered.match(/Sompi purchase approval/g)?.length, 1);
  assert.equal(rendered.match(/To approve, type the exact Purchase ID/g)?.length, 1);

  input.write(`${hostile.purchaseId}\n`);
  assert.equal(await decision, true);
  input.end();
  output.end();
});

test("bounded prompt admission cancels the head, ignores its late answer, and admits the next request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let rendered = "";
  output.on("data", (chunk: string) => { rendered += chunk; });
  const prompt = new TerminalAuthorityApprovalPrompt({
    input,
    output,
    allowNonTtyForTests: true,
    maxPrompts: 2,
  });
  const first = display("pur_DDDDDDDDDDDDDDDDDDDDDD");
  const second = display("pur_EEEEEEEEEEEEEEEEEEEEEE");
  const third = display("pur_FFFFFFFFFFFFFFFFFFFFFF");
  const firstAbort = new AbortController();
  const firstDecision = prompt.approve(first, firstAbort.signal);
  const secondDecision = prompt.approve(second);
  await assert.rejects(
    prompt.approve(third),
    AuthorityPromptBusyError,
  );
  await until(() => rendered.includes(first.purchaseId));
  firstAbort.abort();
  await assert.rejects(firstDecision, { name: "AbortError" });
  await until(() => rendered.includes(second.purchaseId));
  input.write(`${first.purchaseId}\n`);
  assert.equal(await secondDecision, false, "a late answer cannot approve the next Purchase");
  const thirdDecision = prompt.approve(third);
  await until(() => rendered.includes(third.purchaseId));
  input.write(`${third.purchaseId}\n`);
  assert.equal(await thirdDecision, true);
  input.end();
  output.end();
});

function display(purchaseId: string): AuthorityApprovalDisplay {
  return Object.freeze({
    profile: "sompi.purchase-approval.2",
    authorityRequestDigest: "sha256:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    purchaseId,
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
      payTo: "kaspatest:qtest",
    }),
    checkoutDigest: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    purchaseAuthorizationRequestDigest: "sha256:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    purchaseAuthorizationNonceDigest: "sha256:GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    purchaseAuthorizationFactsDigest: "sha256:HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH",
    termsExpiresAt: "2099-01-01T00:00:00.000Z",
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

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("terminal prompt did not render in time");
}
