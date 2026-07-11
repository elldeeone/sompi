import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";

import type { SafeTransportHop } from "../purchase/egress-policy.js";
import { evidenceDigest } from "../purchase/identity.js";
import { NodePinnedHttpTransport } from "./node-pinned-transport.js";

test("Node transport connects to the pinned address while preserving HTTP authority", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.host, `merchant.invalid:${(server.address() as any).port}`);
    assert.equal(request.url, "/resource?x=1");
    response.writeHead(200, { "content-type": "text/plain", "x-proof": "pinned" });
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port as number;
  const hop = fakeHop(port);
  try {
    const response = await new NodePinnedHttpTransport().send({
      hop,
      headers: [],
      body: new Uint8Array(),
      signal: new AbortController().signal,
    });
    assert.equal(response.status, 200);
    assert(response.headers.some(([name, value]) => name.toLowerCase() === "x-proof" && value === "pinned"));
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString("utf8"), "ok");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Node transport rejects authority, framing, duplicate, and control-bearing headers", async () => {
  const transport = new NodePinnedHttpTransport();
  const hop = fakeHop(1);
  for (const headers of [
    [["host", "attacker.example"]],
    [["content-length", "1"]],
    [["transfer-encoding", "chunked"]],
    [["connection", "keep-alive"]],
    [["x-duplicate", "one"], ["X-Duplicate", "two"]],
    [["x-control", "value\tcontinued"]],
  ] as const) {
    await assert.rejects(
      transport.send({
        hop,
        headers,
        body: new Uint8Array(),
        signal: new AbortController().signal,
      }),
      /outbound HTTP header is invalid/
    );
  }
});

function fakeHop(port: number): SafeTransportHop {
  const url = `http://merchant.invalid:${port}/resource?x=1`;
  const limits = Object.freeze({
    maxRedirects: 0,
    maxResolvedAddresses: 1,
    maxResponseHeaderBytes: 32 * 1024,
    maxResponseBodyBytes: 1024,
    requestTimeoutMs: 2_000,
  });
  return Object.freeze({
    url,
    protocol: "http:" as const,
    hostname: "merchant.invalid",
    port,
    method: "GET",
    requestFingerprintInput: Object.freeze({ url, method: "GET" }),
    requestFingerprint: evidenceDigest("request"),
    redirectCount: 0,
    startedAtMs: Date.now(),
    deadlineAtMs: Date.now() + 2_000,
    limits,
    connection: Object.freeze({
      addresses: Object.freeze([{ address: "127.0.0.1", family: 4 as const }]),
      port,
      authority: `merchant.invalid:${port}`,
      serverName: "merchant.invalid",
    }),
  });
}
