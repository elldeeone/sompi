import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parsePaymentRequiredHeaderValue } from "@kaspa-x402/client";
import * as core from "@kaspa-x402/core";

import { KaspaX402ExactPaymentModule } from "../adapters/kaspa-x402/exact-payment-module.js";
import {
  ExactOnlyChannelSigner,
  ExactOnlyChannelStore,
} from "../adapters/kaspa-x402/index.js";
import {
  assertPurchaseId,
  createPaymentIdentifier,
  evidenceDigest,
  requestFingerprint,
} from "../purchase/identity.js";
import { SUPPORTED_PROTOCOL_PROFILES } from "../protocols/profiles.js";

const SOURCE_COMMIT = "28ac222d3a375b9a2a56c11396f388086eeeae76";
const VECTOR_SHA256 = "15b5a878df6453d456b06b36bab3e17f872430bb744efd716a8008a0fbe17a9f";
const VECTOR_BYTES = 7162;
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

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

test("alpha.6 package pins, source/vector provenance, and source lock SRI are exact", () => {
  const provenance = readJson("test/conformance/provenance.json") as any;
  const packageJson = readJson("package.json") as any;
  const lockPath = path.join(process.cwd(), "package-lock.json");
  const lock = fs.existsSync(lockPath) ? readJson("package-lock.json") as any : undefined;
  assert.equal(SUPPORTED_PROTOCOL_PROFILES.x402.npmGitCommit, SOURCE_COMMIT);
  assert.equal(provenance.kaspaX402.sourceCommit, SOURCE_COMMIT);
  assert.equal(provenance.kaspaX402.vector.sha256, VECTOR_SHA256);
  assert.equal(provenance.kaspaX402.vector.bytes, VECTOR_BYTES);

  for (const packageName of ["core", "covenant", "client", "server"] as const) {
    const profile = SUPPORTED_PROTOCOL_PROFILES.x402.packages[packageName];
    const packagePath = `node_modules/@kaspa-x402/${packageName}`;
    const declared = packageJson.dependencies?.[`@kaspa-x402/${packageName}`]
      ?? packageJson.devDependencies?.[`@kaspa-x402/${packageName}`];
    assert.equal(declared, profile.version);
    assert.equal(
      provenance.kaspaX402.npmIntegrity[`@kaspa-x402/${packageName}`],
      profile.integrity
    );
    if (lock) {
      const locked = lock.packages?.[packagePath];
      assert.ok(locked, `${packagePath} is absent from package-lock.json`);
      assert.equal(locked.version, "0.1.0-alpha.6");
      assert.equal(locked.version, profile.version);
      assert.equal(locked.integrity, profile.integrity);
      assert.match(
        locked.resolved,
        new RegExp(`^https://registry\\.npmjs\\.org/@kaspa-x402/${packageName}/-/.+-0\\.1\\.0-alpha\\.6\\.tgz$`)
      );
    }
  }
});

test("unmodified alpha.6 exact HTTP vector validates and crosses Sompi's adapter seam", async () => {
  const vectorPath = path.join(
    process.cwd(),
    "vendor/kaspa-x402-alpha.6-conformance/exact-transaction.json"
  );
  const bytes = fs.readFileSync(vectorPath);
  assert.equal(bytes.byteLength, VECTOR_BYTES);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), VECTOR_SHA256);
  const vector = JSON.parse(bytes.toString("utf8")) as ExactHttpVector;
  assert.equal(vector.kind, "x402-http");

  assert.deepEqual(decodeHeader(vector.headers.paymentRequired), vector.paymentRequired);
  assert.deepEqual(decodeHeader(vector.headers.paymentSignature), vector.paymentPayload);
  assert.deepEqual(decodeHeader(vector.headers.paymentResponse), vector.settlementResponse);
  assert.equal(core.validatePaymentRequired(vector.paymentRequired).ok, true);
  assert.equal(core.validatePaymentPayload(vector.paymentPayload).ok, true);
  assert.deepEqual(
    core.decodePaymentResponseHeader(vector.headers.paymentResponse),
    vector.settlementResponse
  );
  const parsed = parsePaymentRequiredHeaderValue(vector.headers.paymentRequired, {
    supportedNetworks: ["kaspa:testnet-10"],
    supportedSchemes: ["exact"],
  });
  assert.equal(parsed.accepted.scheme, "exact");
  assert.equal(parsed.accepted.extra.binding, "kaspa-exact-v1");

  const fixture = makeAdapterFixture(vector);
  await assert.rejects(
    fixture.module.prepareStaging({
      execution: fixture.execution,
      request: fixture.request,
      paymentRequirements: Buffer.from(vector.headers.paymentRequired, "ascii"),
      additionalCostCeilingAtomic: "10000000",
    }),
    /requires the official payment-identifier extension/
  );

  const correlatedRequired: core.PaymentRequired = {
    ...vector.paymentRequired,
    extensions: {
      ...(vector.paymentRequired.extensions ?? {}),
      "payment-identifier": core.paymentIdentifierExtension({ required: true }),
    },
  };
  assert.equal(core.validatePaymentRequired(correlatedRequired).ok, true);
  const correlatedHeader = core.encodePaymentRequiredHeader(correlatedRequired);
  const prepared = await fixture.module.prepareStaging({
    execution: fixture.execution,
    request: fixture.request,
    paymentRequirements: Buffer.from(correlatedHeader, "ascii"),
    additionalCostCeilingAtomic: "10000000",
  });
  assert.equal(prepared.stagingAmountAtomic, "10000250");
  assert.equal(prepared.expectedOutpoint, `${"aa".repeat(32)}:0`);
  assert.equal(fixture.stagingPrepareCalls(), 1);
});

function makeAdapterFixture(vector: ExactHttpVector) {
  const purchaseId = assertPurchaseId("pur_AgICAgICAgICAgICAgICAg");
  const paymentIdentifier = createPaymentIdentifier(purchaseId, 1);
  const request = {
    url: vector.paymentRequired.resource.url,
    method: "GET",
    body: new Uint8Array(),
    requestFingerprint: requestFingerprint({
      url: vector.paymentRequired.resource.url,
      method: "GET",
      body: new Uint8Array(),
    }),
  };
  const accepted = vector.paymentRequired.accepts[0];
  if (accepted?.scheme !== "exact") throw new Error("fixture lacks exact requirements");
  const reservationExpiresAt = accepted.extra.reservationExpiresAt;
  if (typeof reservationExpiresAt !== "string") {
    throw new Error("fixture lacks exact reservation expiry");
  }
  const checkoutDigest = digest("checkout");
  const requestDigest = digest("authority-request");
  const nonceDigest = digest("authority-nonce");
  const bodyDigest = digest(new Uint8Array());
  const terms = {
    merchant: {
      id: "https://api.example.test",
      name: "Kaspa-x402 Vector Merchant",
      origin: "https://api.example.test",
    },
    resourceFingerprint: request.requestFingerprint,
    amountAtomic: accepted.amount,
    asset: "KAS" as const,
    network: "kaspa:testnet-10" as const,
    payTo: accepted.payTo,
    expiresAt: reservationExpiresAt,
    checkoutDigest,
  };
  const authorizationRequest = {
    purchaseId,
    resourceUrl: request.url,
    method: request.method,
    requestMediaType: "",
    requestBodyDigest: bodyDigest,
    terms,
    requestDigest,
    nonceDigest,
    additionalCostCeilingAtomic: "10000000",
    effectiveFinalityFloor: "accepted" as const,
    createdAtMs: NOW,
    expiresAtMs: Date.parse(terms.expiresAt),
  };
  const facts = {
    purchaseId,
    resourceUrl: request.url,
    method: request.method,
    requestMediaType: "",
    requestBodyDigest: bodyDigest,
    resourceFingerprint: request.requestFingerprint,
    merchantId: terms.merchant.id,
    merchantOrigin: terms.merchant.origin,
    amountAtomic: terms.amountAtomic,
    asset: terms.asset,
    network: terms.network,
    payTo: terms.payTo,
    expiresAt: terms.expiresAt,
    checkoutDigest,
    requestDigest,
    nonceDigest,
    additionalCostCeilingAtomic: "10000000",
    effectiveFinalityFloor: "accepted" as const,
  };
  const execution = {
    purchaseId,
    terms,
    authorizationRequest,
    authorization: {
      purchaseId,
      checkoutDigest,
      decision: "approved" as const,
      authorityId: "authority:conformance",
      evidenceDigest: digest("authority-evidence"),
      facts,
    },
    paymentIdentifier,
  };
  const stagingBytes = Buffer.from("pinned-alpha.6-staging-plan", "utf8");
  let stagingPrepareCalls = 0;
  const module = new KaspaX402ExactPaymentModule({
    staging: {
      prepare: async () => {
        stagingPrepareCalls += 1;
        return {
          preparedBytes: stagingBytes,
          preparedDigest: digest(stagingBytes),
          transactionId: "aa".repeat(32),
          expectedOutpoint: `${"aa".repeat(32)}:0`,
          stagingAmountAtomic: "10000250",
          fundingSource: "vault-treasury",
        };
      },
      submit: async () => { throw new Error("not used by conformance preparation"); },
      observe: async () => { throw new Error("not used by conformance preparation"); },
    },
    funding: {
      createProvider: async () => { throw new Error("not used by conformance preparation"); },
    },
    channelSigner: new ExactOnlyChannelSigner(),
    channelStore: new ExactOnlyChannelStore(),
    addressCodec: {
      scriptPublicKeyForAddress: () => { throw new Error("not used"); },
      encodeScriptAddress: () => { throw new Error("not used"); },
    },
    transport: {
      send: async () => { throw new Error("not used by conformance preparation"); },
    },
    settlementVerifier: {
      verify: async () => { throw new Error("not used by conformance preparation"); },
    },
    recoveryObserver: {
      observe: async () => { throw new Error("not used by conformance preparation"); },
    },
    now: () => NOW,
  });
  return { module, execution, request, stagingPrepareCalls: () => stagingPrepareCalls };
}

function decodeHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), "utf8"));
}

function digest(value: string | Uint8Array): ReturnType<typeof evidenceDigest> {
  return evidenceDigest(value);
}
