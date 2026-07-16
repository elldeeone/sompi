import * as assert from "node:assert/strict";
import test from "node:test";

import { PurchaseApiClient, PurchaseApiClientError } from "./client.js";
import { generateAgentApiCredential } from "./credential.js";
import type { PurchaseView } from "../purchase/types.js";

test("API client sends fixed authenticated no-redirect requests and validates results", async () => {
  const credential = generateAgentApiCredential();
  const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    const body = JSON.stringify(fakeView());
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    }) as Response;
  };
  // Native Response.url is immutable, so wrap it with the effective target.
  const effectiveFetch: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    return new Proxy(response, { get(target, property, receiver) {
      if (property === "url") return String(input);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Response;
  };
  const client = new PurchaseApiClient({ baseUrl: "http://127.0.0.1:7442", credential, fetch: effectiveFetch });
  assert.equal((await client.purchase({ requestKey: "api:one", url: "https://merchant.example/" })).id, fakeView().id);
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, `Bearer ${credential.token}`);
});

test("API client rejects redirected, oversized, and malformed responses", async () => {
  const credential = generateAgentApiCredential();
  const redirected: typeof fetch = async () => new Proxy(new Response("{}", {
    status: 200, headers: { "content-type": "application/json" },
  }), { get(target, property, receiver) {
    if (property === "url") return "http://127.0.0.1:7442/elsewhere";
    if (property === "redirected") return true;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as Response;
  const client = new PurchaseApiClient({ baseUrl: "http://127.0.0.1:7442", credential, fetch: redirected });
  await assert.rejects(() => client.status(fakeView().id), (error: unknown) =>
    error instanceof PurchaseApiClientError && error.code === "UNEXPECTED_RESPONSE_TARGET");
  assert.throws(() => new PurchaseApiClient({ baseUrl: "http://merchant.example", credential }), /loopback/);
});

function fakeView(): PurchaseView {
  return {
    id: "pur_0123456789ABCDEFGHIJKL" as PurchaseView["id"],
    requestKey: "api:one" as PurchaseView["requestKey"], state: "created", summary: "Purchase created.",
    resourceFingerprint: `sha256:${"A".repeat(43)}` as PurchaseView["resourceFingerprint"],
    authorization: { status: "not_requested" }, treasury: { status: "unreserved" },
    paymentAttempts: [], receiptEvidence: [],
  };
}
