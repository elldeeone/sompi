#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const AFFECTED_REVISION = "4ebb82d4f82bac46ae3addd112c4752f29630a8a";
const QUEUE_DEPTH = 128;

const target = path.resolve(process.cwd(), process.env.SOMPI_TARGET ?? "../target");
const moduleUrl = pathToFileURL(
  path.join(target, "dist/adapters/ap2/human-authority.js"),
).href;
const { TerminalAuthorityApprovalPrompt } = await import(moduleUrl);

const input = new PassThrough();
const output = new PassThrough();
output.setEncoding("utf8");

let rendered = "";
output.on("data", (chunk) => {
  rendered += chunk;
});

const prompt = new TerminalAuthorityApprovalPrompt({
  input,
  output,
  allowNonTtyForTests: true,
});

let settled = 0;
const pending = Array.from({ length: QUEUE_DEPTH }, (_, index) => {
  const decision = prompt.approve(display(purchaseId(index)));
  void decision.then(
    () => {
      settled += 1;
    },
    () => {
      settled += 1;
    },
  );
  return decision;
});

await until(() => rendered.includes(purchaseId(0)));
await new Promise((resolve) => setTimeout(resolve, 50));

const observation = {
  queuedPromptPromises: pending.length,
  settledAfter50Ms: settled,
  firstPromptRendered: rendered.includes(purchaseId(0)),
  secondPromptRendered: rendered.includes(purchaseId(1)),
  renderedCeremonies: rendered.match(/Sompi purchase approval/g)?.length ?? 0,
};

assert.equal(observation.queuedPromptPromises, QUEUE_DEPTH);
assert.equal(observation.settledAfter50Ms, 0);
assert.equal(observation.firstPromptRendered, true);
assert.equal(observation.secondPromptRendered, false);
assert.equal(observation.renderedCeremonies, 1);

console.log(`[+] affected revision: ${AFFECTED_REVISION}`);
console.log(`[+] queued prompt promises: ${observation.queuedPromptPromises}`);
console.log(`[+] settled after 50 ms: ${observation.settledAfter50Ms}`);
console.log(`[+] first prompt rendered: ${observation.firstPromptRendered}`);
console.log(`[+] second prompt rendered: ${observation.secondPromptRendered}`);
console.log(`[+] rendered ceremonies: ${observation.renderedCeremonies}`);
console.log("[+] prompt queue remained blocked behind the unanswered first ceremony");
console.log("[+] no socket, credential, Merchant, RPC, or blockchain operation was performed");

input.destroy();
output.destroy();

function purchaseId(index) {
  return `pur_${index.toString(16).padStart(22, "A")}`;
}

function display(id) {
  return Object.freeze({
    purchaseId: id,
    merchant: Object.freeze({
      id: "merchant:test",
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
      amountAtomic: "1",
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: "kaspatest:qtest",
    }),
    checkoutDigest: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    termsExpiresAt: "2099-01-01T00:00:00.000Z",
    additionalCostCeilingAtomic: "0",
    recoveryRetry: false,
  });
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("first terminal prompt did not render");
}
