import * as assert from "node:assert/strict";
import test from "node:test";
import {
  EgressPolicy,
  EgressPolicyError,
  assertPublicAddress,
  type EgressResolver,
  type ResolvedAddress,
} from "./egress-policy.js";
import { requestFingerprint } from "./identity.js";

test("defaults to HTTPS and returns a canonical, address-pinned transport contract", async () => {
  const dns = fakeResolver({ "merchant.example": [v4("8.8.8.8"), v6("2001:4860:4860::8888")] });
  const policy = policyFor(dns.resolve);
  const hop = await policy.validateRequest({
    url: "HTTPS://Merchant.Example:443/a/../resource#fragment",
    method: " get ",
    body: Buffer.from("request-body"),
  });

  assert.equal(hop.url, "https://merchant.example/resource");
  assert.equal(hop.hostname, "merchant.example");
  assert.equal(hop.port, 443);
  assert.equal(hop.method, "GET");
  assert.equal(hop.connection.authority, "merchant.example");
  assert.equal(hop.connection.serverName, "merchant.example");
  assert.deepEqual(hop.connection.addresses, [v4("8.8.8.8"), v6("2001:4860:4860::8888")]);
  assert.equal(hop.requestFingerprint, requestFingerprint(hop.requestFingerprintInput));
  const firstBody = hop.body;
  assert.ok(firstBody);
  firstBody[0] ^= 0xff;
  assert.deepEqual(hop.body, Uint8Array.from(Buffer.from("request-body")));
  assert.equal(hop.requestFingerprint, requestFingerprint(hop.requestFingerprintInput));
  assert.deepEqual(dns.calls, ["merchant.example"]);
});

test("request fingerprint binds canonical media type as well as exact body bytes", async () => {
  const policy = policyFor(fakeResolver({ "merchant.example": [v4("8.8.8.8")] }).resolve);
  const json = await policy.validateRequest({
    url: "https://merchant.example/resource",
    method: "POST",
    body: Buffer.from("{}"),
    mediaType: "Application/JSON; Charset=utf-8",
  });
  const text = await policy.validateRequest({
    url: "https://merchant.example/resource",
    method: "POST",
    body: Buffer.from("{}"),
    mediaType: "text/plain; charset=utf-8",
  });
  assert.equal(json.requestFingerprintInput.mediaType, "application/json; charset=utf-8");
  assert.notEqual(json.requestFingerprint, text.requestFingerprint);
});

test("HTTP is unconditionally denied even with an explicit port rule", async () => {
  const dns = fakeResolver({ "merchant.example": [v4("8.8.8.8")] });
  await assert.rejects(
    policyFor(dns.resolve).validateRequest({ url: "http://merchant.example/", method: "GET" }),
    errorCode("protocol_denied")
  );

  const explicitlyAllowlisted = policyFor(dns.resolve, {
    allowRules: [{ hostname: "merchant.example", ports: [80, 443] }],
  });
  await assert.rejects(
    explicitlyAllowlisted.validateRequest({ url: "http://merchant.example/", method: "GET" }),
    errorCode("protocol_denied")
  );
});

test("credentials, wildcard hosts, unlisted hosts, subdomains, and ports fail closed", async () => {
  const dns = fakeResolver({
    "merchant.example": [v4("8.8.8.8")],
    "sub.merchant.example": [v4("8.8.4.4")],
  });
  const policy = policyFor(dns.resolve);

  await assert.rejects(
    policy.validateRequest({ url: "https://user:secret@merchant.example/", method: "GET" }),
    errorCode("credentials_denied")
  );
  await assert.rejects(
    policy.validateRequest({ url: "https://sub.merchant.example/", method: "GET" }),
    errorCode("host_denied")
  );
  await assert.rejects(
    policy.validateRequest({ url: "https://merchant.example:8443/", method: "GET" }),
    errorCode("port_denied")
  );
  assert.throws(
    () => policyFor(dns.resolve, { allowRules: [{ hostname: "*.example", ports: [443] }] }),
    errorCode("invalid_configuration")
  );
});

test("every IPv4 non-public class is denied, including metadata and transition ranges", async () => {
  const denied = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ];
  for (const address of denied) {
    const dns = fakeResolver({ "merchant.example": [v4(address)] });
    await assert.rejects(
      policyFor(dns.resolve).validateRequest({ url: "https://merchant.example/", method: "GET" }),
      errorCode("unsafe_address"),
      address
    );
  }
  assert.doesNotThrow(() => assertPublicAddress("8.8.8.8"));
});

test("every IPv6 non-public class and IPv4-mapped address is denied", async () => {
  const denied = [
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "3fff::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ];
  for (const address of denied) {
    const dns = fakeResolver({ "merchant.example": [v6(address)] });
    await assert.rejects(
      policyFor(dns.resolve).validateRequest({ url: "https://merchant.example/", method: "GET" }),
      errorCode("unsafe_address"),
      address
    );
  }
  assert.doesNotThrow(() => assertPublicAddress("2001:4860:4860::8888"));
});

test("mixed public/private DNS answers fail closed and answer count is bounded", async () => {
  const mixed = fakeResolver({ "merchant.example": [v4("8.8.8.8"), v4("10.0.0.1")] });
  await assert.rejects(
    policyFor(mixed.resolve).validateRequest({ url: "https://merchant.example/", method: "GET" }),
    errorCode("unsafe_address")
  );

  const many = fakeResolver({
    "merchant.example": Array.from({ length: 5 }, (_, index) => v4(`8.8.8.${index + 1}`)),
  });
  await assert.rejects(
    policyFor(many.resolve, { limits: { maxResolvedAddresses: 4 } }).validateRequest({
      url: "https://merchant.example/",
      method: "GET",
    }),
    errorCode("resolution_failed")
  );
});

test("IP literals are still resolved, validated, and pinned to the same literal", async () => {
  const dns = fakeResolver({ "8.8.8.8": [v4("8.8.8.8")] });
  const policy = policyFor(dns.resolve, { allowRules: [{ hostname: "8.8.8.8", ports: [443] }] });
  const hop = await policy.validateRequest({ url: "https://8.8.8.8/dns-query", method: "GET" });
  assert.deepEqual(dns.calls, ["8.8.8.8"]);
  assert.equal(hop.connection.serverName, undefined);
  assert.deepEqual(hop.connection.addresses, [v4("8.8.8.8")]);

  const mismatched = fakeResolver({ "8.8.8.8": [v4("8.8.4.4")] });
  await assert.rejects(
    policyFor(mismatched.resolve, { allowRules: [{ hostname: "8.8.8.8", ports: [443] }] }).validateRequest({
      url: "https://8.8.8.8/",
      method: "GET",
    }),
    errorCode("resolution_failed")
  );
});

test("redirects are resolved and revalidated on every hop", async () => {
  const dns = fakeResolver({
    "merchant.example": [v4("8.8.8.8")],
    "cdn.example": [v4("1.1.1.1")],
  });
  const policy = policyFor(dns.resolve, {
    allowRules: [
      { hostname: "merchant.example", ports: [443] },
      { hostname: "cdn.example", ports: [443] },
    ],
  });
  const first = await policy.validateRequest({ url: "https://merchant.example/start", method: "POST", body: Buffer.from("x") });
  const second = await policy.validateRedirect(first, "https://cdn.example/content", {
    method: "GET",
    body: new Uint8Array(),
  });
  assert.equal(second.redirectCount, 1);
  assert.equal(second.hostname, "cdn.example");
  assert.deepEqual(dns.calls, ["merchant.example", "cdn.example"]);
  assert.notEqual(second.requestFingerprint, first.requestFingerprint);

  await assert.rejects(
    policy.validateRedirect(first, "https://cdn.example/content", { method: "GET" }),
    errorCode("redirect_request_invalid")
  );
});

test("redirects to unsafe addresses and excessive redirects are denied", async () => {
  const dns = fakeResolver({
    "merchant.example": [v4("8.8.8.8")],
    "redirect.example": [v4("169.254.169.254")],
  });
  const policy = policyFor(dns.resolve, {
    allowRules: [
      { hostname: "merchant.example", ports: [443] },
      { hostname: "redirect.example", ports: [443] },
    ],
    limits: { maxRedirects: 1 },
  });
  const first = await policy.validateRequest({ url: "https://merchant.example/", method: "GET" });
  await assert.rejects(
    policy.validateRedirect(first, "https://redirect.example/latest"),
    errorCode("unsafe_address")
  );

  const same = await policy.validateRedirect(first, "/next");
  await assert.rejects(policy.validateRedirect(same, "/again"), errorCode("redirect_limit"));
});

test("response guard aborts streaming headers, body, and time overruns", async () => {
  let now = 1_000;
  const dns = fakeResolver({ "merchant.example": [v4("8.8.8.8")] });
  const policy = policyFor(dns.resolve, {
    now: () => now,
    limits: {
      maxResponseHeaderBytes: 32,
      maxResponseBodyBytes: 5,
      requestTimeoutMs: 100,
    },
  });
  const hop = await policy.validateRequest({ url: "https://merchant.example/", method: "GET" });
  const aborted: EgressPolicyError[] = [];
  let guard = policy.createResponseGuard(hop, (reason) => aborted.push(reason));
  assert.equal(guard.acceptHeaders([["x", "ok"]]), 9);
  assert.equal(guard.acceptBodyChunk(Buffer.from("123")), 3);
  assert.throws(() => guard.acceptBodyChunk(Buffer.from("456")), errorCode("response_body_too_large"));
  assert.equal(aborted.at(-1)?.code, "response_body_too_large");

  guard = policy.createResponseGuard(hop, (reason) => aborted.push(reason));
  assert.throws(() => guard.acceptHeaders([["x-long", "a".repeat(30)]]), errorCode("response_headers_too_large"));
  assert.equal(aborted.at(-1)?.code, "response_headers_too_large");

  guard = policy.createResponseGuard(hop, (reason) => aborted.push(reason));
  now = 1_100;
  assert.throws(() => guard.checkTime(), errorCode("deadline_exceeded"));
  assert.equal(aborted.at(-1)?.code, "deadline_exceeded");
});

test("resolver and clock failures fail closed without live DNS", async () => {
  const failed: EgressResolver = async () => {
    throw new Error("simulated resolver outage");
  };
  await assert.rejects(
    policyFor(failed).validateRequest({ url: "https://merchant.example/", method: "GET" }),
    errorCode("resolution_failed")
  );
  assert.throws(
    () => policyFor(fakeResolver({ "merchant.example": [v4("8.8.8.8")] }).resolve, { now: () => Number.NaN }),
    errorCode("invalid_configuration")
  );
});

interface TestPolicyOverrides {
  allowRules?: readonly { hostname: string; ports: readonly number[] }[];
  limits?: Partial<{
    maxRedirects: number;
    maxResolvedAddresses: number;
    maxResponseHeaderBytes: number;
    maxResponseBodyBytes: number;
    requestTimeoutMs: number;
  }>;
  now?: () => number;
}

function policyFor(resolver: EgressResolver, overrides: TestPolicyOverrides = {}): EgressPolicy {
  return new EgressPolicy({
    allowRules: overrides.allowRules ?? [{ hostname: "merchant.example", ports: [443] }],
    resolver,
    limits: overrides.limits,
    now: overrides.now,
  });
}

function fakeResolver(records: Readonly<Record<string, readonly ResolvedAddress[]>>) {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (hostname: string) => {
      calls.push(hostname);
      return records[hostname] ?? [];
    },
  };
}

function v4(address: string): ResolvedAddress {
  return { address, family: 4 };
}

function v6(address: string): ResolvedAddress {
  return { address, family: 6 };
}

function errorCode(code: EgressPolicyError["code"]) {
  return (error: unknown) => error instanceof EgressPolicyError && error.code === code;
}
