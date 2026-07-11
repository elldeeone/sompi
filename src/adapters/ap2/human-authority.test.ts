import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  TerminalAuthorityApprovalPrompt,
  type AuthorityApprovalDisplay,
} from "./human-authority.js";

test("terminal authority serializes concurrent Purchase ceremonies", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let rendered = "";
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });
  const prompt = new TerminalAuthorityApprovalPrompt({ input, output });
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

function display(purchaseId: string): AuthorityApprovalDisplay {
  return Object.freeze({
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
    termsExpiresAt: "2099-01-01T00:00:00.000Z",
    additionalCostCeilingAtomic: "100",
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
