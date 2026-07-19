import assert from "node:assert/strict";
import test from "node:test";

import type { ExactPaymentRequirements } from "@kaspa-x402/core";

import { x402HttpRequestHash } from "./request-hash.js";

const DEMO_ACCEPTED: ExactPaymentRequirements = {
  scheme: "exact",
  network: "kaspa:testnet-10",
  amount: "20000000",
  asset: "KAS",
  payTo: "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh",
  maxTimeoutSeconds: 60,
  extra: {
    binding: "kaspa-exact-v2",
    profile: "standard-native",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    payToScriptPublicKey: "000020bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9ac",
    finality: "accepted",
  },
};

test("bodyless HTTP requestHash matches the landed alpha.8 demo fingerprint", () => {
  assert.equal(
    x402HttpRequestHash(
      {
        url: "https://demo.kaspa-x402.org/exact/report",
        method: "GET",
        body: new Uint8Array(),
      },
      DEMO_ACCEPTED,
    ),
    "0838eb9f74871c02af933047b42097a73529167a50cbc05be5c6ad10ca2e88a5",
  );
});

test("JSON requestHash is canonical and binds the selected requirements", () => {
  const first = x402HttpRequestHash(
    {
      url: "https://merchant.example/resource",
      method: "POST",
      mediaType: "application/json; charset=utf-8",
      body: Buffer.from('{"b":2,"a":1}'),
    },
    DEMO_ACCEPTED,
  );
  const reordered = x402HttpRequestHash(
    {
      url: "https://merchant.example/resource",
      method: "POST",
      mediaType: "application/json",
      body: Buffer.from('{"a":1,"b":2}'),
    },
    DEMO_ACCEPTED,
  );
  assert.equal(first, reordered);
  assert.notEqual(
    first,
    x402HttpRequestHash(
      {
        url: "https://merchant.example/resource",
        method: "POST",
        mediaType: "application/json",
        body: Buffer.from('{"a":1,"b":2}'),
      },
      { ...DEMO_ACCEPTED, amount: "20000001" },
    ),
  );
});

test("unprofiled binary bodies fail before signing", () => {
  assert.throws(
    () =>
      x402HttpRequestHash(
        {
          url: "https://merchant.example/resource",
          method: "POST",
          mediaType: "application/octet-stream",
          body: Uint8Array.of(0xff),
        },
        DEMO_ACCEPTED,
      ),
    /explicit interoperable body profile|empty, JSON, or UTF-8 text body/,
  );
});
