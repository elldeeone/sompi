import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parsePaymentRequiredHeaderValue } from "@kaspa-x402/client";
import * as core from "@kaspa-x402/core";

import { SUPPORTED_PROTOCOL_PROFILES } from "../protocols/profiles.js";

const SOURCE_COMMIT = "49977139b8200336968f38e83a8e6700a1e3a36c";
const RELEASE_COMMIT = SOURCE_COMMIT;
const RELEASE_TAG_OBJECT = "0387f7a27d55400274237cee3e2cc2ea73c82dc8";
const HTTP_VECTOR_SHA256 = "36564ac622863b7621f3d95fb1fa6c8a126d813d238919c3aa856c4a04cd0508";
const HTTP_VECTOR_BYTES = 13_933;
const CONSENSUS_VECTOR_SHA256 = "ade8af92f002fc36f5abc80a7a69e698732e8d0956965d17a79ab2463c6706ec";
const CONSENSUS_VECTOR_BYTES = 8_238;
const EXACT_INTEROP_SHA256 = "50e72df3c44edb8cce6b76bc8925c479eddcae8ff07eb6b8a0a65856874add94";
const EXACT_INTEROP_BYTES = 13_229;
const BATCH_INTEROP_SHA256 = "cfc488a31f241f1e4c126a33b389c3b9c6a0d121dc1cf69e485e4d070933a4e8";
const BATCH_INTEROP_BYTES = 11_271;

interface ExactHttpVector {
  readonly kind: "x402-http";
  readonly paymentRequired: core.PaymentRequired;
  readonly paymentPayload: core.PaymentPayload;
  readonly settlementResponse: core.SettlementResponse;
  readonly headers: {
    readonly paymentRequired: string;
    readonly paymentSignature: string;
    readonly paymentResponse: string;
  };
}

test("alpha.9 package, source, release, and vector provenance are exact", () => {
  const provenance = readJson("test/conformance/provenance.json") as any;
  const packageJson = readJson("package.json") as any;
  const lock = readJson("package-lock.json") as any;
  const recorded = provenance.kaspaX402;

  assert.equal(SUPPORTED_PROTOCOL_PROFILES.x402.npmGitCommit, SOURCE_COMMIT);
  assert.equal(recorded.sourceCommit, SOURCE_COMMIT);
  assert.equal(recorded.releaseCommit, RELEASE_COMMIT);
  assert.equal(recorded.releaseTagObject, RELEASE_TAG_OBJECT);
  assert.deepEqual(recorded.profiles, ["standard-native", "additive", "batch-settlement"]);
  assertVector(recorded.vectors.http, HTTP_VECTOR_BYTES, HTTP_VECTOR_SHA256);
  assertVector(recorded.vectors.consensus, CONSENSUS_VECTOR_BYTES, CONSENSUS_VECTOR_SHA256);
  assertVector(recorded.vectors.exactInterop, EXACT_INTEROP_BYTES, EXACT_INTEROP_SHA256);
  assertVector(recorded.vectors.batchInterop, BATCH_INTEROP_BYTES, BATCH_INTEROP_SHA256);

  for (const packageName of ["core", "covenant", "client", "server"] as const) {
    const profile = SUPPORTED_PROTOCOL_PROFILES.x402.packages[packageName];
    const packagePath = `node_modules/@kaspa-x402/${packageName}`;
    assert.equal(packageJson.dependencies?.[`@kaspa-x402/${packageName}`], profile.version);
    assert.equal(recorded.npmIntegrity[`@kaspa-x402/${packageName}`], profile.integrity);
    const locked = lock.packages?.[packagePath];
    assert.ok(locked, `${packagePath} is absent from package-lock.json`);
    assert.equal(locked.version, "0.1.0-alpha.9");
    assert.equal(locked.version, profile.version);
    assert.equal(locked.integrity, profile.integrity);
    assert.match(
      locked.resolved,
      new RegExp(`^https://registry\\.npmjs\\.org/@kaspa-x402/${packageName}/-/.+-0\\.1\\.0-alpha\\.9\\.tgz$`)
    );
  }
});

test("unmodified alpha.9 exact HTTP vector validates at the public package seam", () => {
  const vector = readPinnedVector<ExactHttpVector>(
    "vendor/kaspa-x402-alpha.9-conformance/exact-transaction.json",
    HTTP_VECTOR_BYTES,
    HTTP_VECTOR_SHA256
  );
  assert.equal(vector.kind, "x402-http");
  assert.deepEqual(decodeHeader(vector.headers.paymentRequired), vector.paymentRequired);
  assert.deepEqual(decodeHeader(vector.headers.paymentSignature), vector.paymentPayload);
  assert.deepEqual(decodeHeader(vector.headers.paymentResponse), vector.settlementResponse);
  assert.equal(core.validatePaymentRequired(vector.paymentRequired).ok, true);
  assert.equal(core.validatePaymentPayload(vector.paymentPayload).ok, true);
  assert.equal(core.validatePaymentRetry({
    paymentRequired: vector.paymentRequired,
    paymentPayload: vector.paymentPayload,
  }).ok, true);
  assert.deepEqual(core.decodePaymentResponseHeader(vector.headers.paymentResponse), vector.settlementResponse);

  const parsed = parsePaymentRequiredHeaderValue(vector.headers.paymentRequired, {
    supportedNetworks: ["kaspa:testnet-10"],
    supportedSchemes: ["exact"],
  });
  assert.equal(parsed.accepted.scheme, "exact");
  assert.equal(parsed.accepted.extra.binding, "kaspa-exact-v2");
  assert.equal(parsed.accepted.extra.profile, "additive");
  assert.equal(parsed.accepted.extra.paymentOutputIndex, 0);
  assert.equal(vector.paymentPayload.payload.type, "exact-transaction");
});

test("unmodified alpha.9 consensus vector proves both exact economic profiles", () => {
  const vector = readPinnedVector<any>(
    "vendor/kaspa-x402-alpha.9-conformance/consensus-profiles.json",
    CONSENSUS_VECTOR_BYTES,
    CONSENSUS_VECTOR_SHA256
  );
  assert.equal(vector.kind, "exact-consensus-profiles");
  assert.equal(vector.validation.status, "full-consensus-cross-validated");
  assert.equal(vector.validation.sourceCommit, "78257f273a26c4be085bab0f79437dee99ca8835");

  const standard = vector.expected.standardNative;
  assert.equal(standard.profile, "standard-native");
  assert.equal(standard.version, 0);
  assert.equal(standard.transaction.version, 0);
  assert.equal(standard.transaction.outputs[0].amount, standard.amount);
  assert.equal(standard.computeCommitments[0].sigOpCount, 1);

  const additive = vector.expected.additive;
  assert.equal(additive.profile, "additive");
  assert.equal(additive.version, 1);
  assert.equal(additive.transaction.version, 1);
  const headAmount = BigInt(additive.transaction.inputs[0].utxo.amount);
  const successorAmount = BigInt(additive.transaction.outputs[0].amount);
  assert.equal((successorAmount - headAmount).toString(), additive.amount);
  const headScript = additive.transaction.outputs[0].scriptPublicKey;
  assert.equal(
    additive.transaction.outputs.filter((output: any) => output.scriptPublicKey === headScript).length,
    1
  );
  assert.equal(vector.expected.mutations.additiveDuplicateMerchantBenefit, "profile-rejected-after-consensus-acceptance");
});

test("unmodified alpha.9 exact interop vector proves canonical expiry decisions", () => {
  const vector = readPinnedVector<any>(
    "vendor/kaspa-x402-alpha.9-conformance/exact-interop-v1.json",
    EXACT_INTEROP_BYTES,
    EXACT_INTEROP_SHA256
  );
  assert.equal(core.stableStringify(vector.paymentRequirements.value), vector.paymentRequirements.canonicalJsonUtf8);
  assert.equal(core.sha256Hex(vector.paymentRequirements.canonicalJsonUtf8), vector.paymentRequirements.sha256);
  assert.equal(core.exactRequestAuthorizationPreimage(vector.requestAuthorization.input), vector.requestAuthorization.canonicalJsonUtf8);
  assert.equal(core.sha256Hex(vector.requestAuthorization.canonicalJsonUtf8), vector.requestAuthorization.sha256);
  const nowMs = Date.parse(vector.expiry.referenceTime);
  for (const decision of vector.expiry.cases) {
    assert.equal(core.exactAuthorizationExpiryError({
      maxTimeoutSeconds: vector.expiry.maxTimeoutSeconds,
      authorizationExpiresAt: decision.authorizationExpiresAt,
      ...(decision.challengeExpiresAt ? { challengeExpiresAt: decision.challengeExpiresAt } : {}),
      nowMs,
    }) ?? "valid", decision.expected, decision.name);
  }
});

test("unmodified alpha.9 batch interop vector proves canonical requirements and commitment IDs", () => {
  const vector = readPinnedVector<any>(
    "vendor/kaspa-x402-alpha.9-conformance/batch-interop-v1.json",
    BATCH_INTEROP_BYTES,
    BATCH_INTEROP_SHA256
  );
  assert.equal(core.channelIdPreimageHex(vector.channel.config), vector.channel.preimage);
  assert.equal(core.channelId(vector.channel.config), vector.channel.channelId);
  assert.equal(core.voucherPreimageHex(vector.voucher.input), vector.voucher.preimage);
  assert.equal(core.voucherDigest(vector.voucher.input), vector.voucher.digest);
  assert.equal(core.batchPaymentRequirementsPreimageHex(vector.paymentRequirements.value), vector.paymentRequirements.preimage);
  assert.equal(core.batchPaymentRequirementsHash(vector.paymentRequirements.value), vector.paymentRequirements.sha256);
  assert.equal(core.batchCommitmentPreimageHex(vector.commitment.input), vector.commitment.preimage);
  assert.equal(core.batchCommitmentId(vector.commitment.input), vector.commitment.commitmentId);
  assert.throws(() => core.batchCommitmentId({
    ...vector.commitment.input,
    chargedCumulativeAfter: vector.commitment.input.chargedCumulativeBefore,
  }), /prior amount plus the charge/);
});

function assertVector(
  record: { vendoredPath: string; bytes: number; sha256: string },
  bytes: number,
  sha256: string
): void {
  assert.equal(record.bytes, bytes);
  assert.equal(record.sha256, sha256);
  readPinnedVector(record.vendoredPath, bytes, sha256);
}

function readPinnedVector<T>(relative: string, bytes: number, sha256: string): T {
  const value = fs.readFileSync(path.join(process.cwd(), relative));
  assert.equal(value.byteLength, bytes);
  assert.equal(createHash("sha256").update(value).digest("hex"), sha256);
  return JSON.parse(value.toString("utf8")) as T;
}

function decodeHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function readJson(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relative), "utf8"));
}
