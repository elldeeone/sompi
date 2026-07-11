import assert from "node:assert/strict";
import fs from "node:fs";

import {
  issueHumanPresentMandates,
  verifyHumanPresentMandates,
} from "../adapters/ap2/mandates.js";
import { verifyMerchantCheckout } from "../adapters/ap2/merchant-checkout.js";
import {
  issueCheckoutReceipt,
  issuePaymentReceipt,
} from "../adapters/ap2/receipts.js";
import {
  AUTHORITY_SIGNER,
  FIXED_AUDIENCE,
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  FIXED_MERCHANT_ISSUER,
  FIXED_MERCHANT_RECEIPT_ISSUER,
  FIXED_NOW,
  FIXED_PAYMENT_RECEIPT_ISSUER,
  FIXED_PURCHASE_ID,
  MERCHANT_RECEIPT_SIGNER,
  PAYMENT_RECEIPT_SIGNER,
  fixedMerchantClaims,
  fixedTrustStore,
  fixedVerifiedCheckout,
} from "../adapters/ap2/test-fixtures.js";

const FIXTURE_ID = "sompi-ap2-v0.2-cross-language-1";
const CHECKOUT_ORDER_ID = "order:conformance:1";
const PAYMENT_ID = "pay_conformance_1";
const PSP_CONFIRMATION_ID = "psp_conformance_1";
const NETWORK_CONFIRMATION_ID = "tx_conformance_1";

interface TypeScriptBridgeDocument {
  readonly schemaVersion: 1;
  readonly fixtureId: typeof FIXTURE_ID;
  readonly checkout: {
    readonly artifact: string;
    readonly checkoutHash: string;
  };
  readonly typescriptIssued: {
    readonly checkoutMandate: string;
    readonly paymentMandate: string;
    readonly checkoutReceipt: string;
    readonly paymentReceipt: string;
  };
}

interface PythonBridgeDocument {
  readonly schemaVersion: 1;
  readonly fixtureId: typeof FIXTURE_ID;
  readonly pythonIssued: {
    readonly checkoutMandate: string;
    readonly paymentMandate: string;
  };
}

async function emitTypeScript(outputPath: string): Promise<void> {
  const checkout = await fixedVerifiedCheckout();
  const mandateArtifacts = await issueHumanPresentMandates({
    checkout,
    instrumentId: FIXED_INSTRUMENT_ID,
    issuedAtSec: FIXED_NOW + 10,
    expiresAtSec: FIXED_NOW + 300,
  }, AUTHORITY_SIGNER);
  const mandates = await verifyHumanPresentMandates(mandateArtifacts, {
    trust: fixedTrustStore(),
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    checkout,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    nowSec: FIXED_NOW + 11,
    clockSkewSec: 0,
  });
  const [checkoutReceipt, paymentReceipt] = await Promise.all([
    issueCheckoutReceipt({
      status: "Success",
      mandate: mandates.checkout,
      orderId: CHECKOUT_ORDER_ID,
      issuedAtSec: FIXED_NOW + 20,
    }, MERCHANT_RECEIPT_SIGNER),
    issuePaymentReceipt({
      status: "Success",
      mandate: mandates.payment,
      paymentId: PAYMENT_ID,
      pspConfirmationId: PSP_CONFIRMATION_ID,
      networkConfirmationId: NETWORK_CONFIRMATION_ID,
      issuedAtSec: FIXED_NOW + 20,
    }, PAYMENT_RECEIPT_SIGNER),
  ]);
  writePrivateJson(outputPath, {
    schemaVersion: 1,
    fixtureId: FIXTURE_ID,
    checkout: {
      artifact: checkout.artifact,
      checkoutHash: checkout.checkoutHash,
    },
    typescriptIssued: {
      checkoutMandate: mandateArtifacts.checkoutMandate,
      paymentMandate: mandateArtifacts.paymentMandate,
      checkoutReceipt,
      paymentReceipt,
    },
  } satisfies TypeScriptBridgeDocument);
}

async function verifyPython(
  typescriptPath: string,
  pythonPath: string
): Promise<void> {
  const typescript = readBridgeJson<TypeScriptBridgeDocument>(typescriptPath);
  const python = readBridgeJson<PythonBridgeDocument>(pythonPath);
  assert.equal(typescript.schemaVersion, 1);
  assert.equal(typescript.fixtureId, FIXTURE_ID);
  assert.equal(python.schemaVersion, 1);
  assert.equal(python.fixtureId, FIXTURE_ID);
  assert.deepEqual(Object.keys(python).sort(), ["fixtureId", "pythonIssued", "schemaVersion"]);
  assert.deepEqual(Object.keys(python.pythonIssued).sort(), ["checkoutMandate", "paymentMandate"]);

  const claims = fixedMerchantClaims();
  const checkout = await verifyMerchantCheckout(typescript.checkout.artifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_ISSUER,
    expectedAudience: FIXED_AUDIENCE,
    expectedPurchaseId: FIXED_PURCHASE_ID as never,
    expectedResourceFingerprint: claims.resource.request_fingerprint as never,
    expectedPaymentRequirementsDigest: claims.x402.payment_requirements_digest as never,
    nowSec: FIXED_NOW + 11,
    clockSkewSec: 0,
  });
  assert.equal(checkout.checkoutHash, typescript.checkout.checkoutHash);
  const verified = await verifyHumanPresentMandates(python.pythonIssued, {
    trust: fixedTrustStore(),
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    checkout,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    nowSec: FIXED_NOW + 11,
    clockSkewSec: 0,
  });
  assert.equal(verified.checkout.content.checkout_jwt, checkout.artifact);
  assert.equal(verified.checkout.content.checkout_hash, checkout.checkoutHash);
  assert.equal(verified.payment.content.transaction_id, checkout.checkoutHash);
  assert.equal(verified.payment.amountAtomic, checkout.terms.amountAtomic);
  assert.equal(verified.payment.content.payment_instrument.network, "kaspa:testnet-10");
}

function readBridgeJson<T>(filePath: string): T {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as T;
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  fs.chmodSync(filePath, 0o600);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, firstPath, secondPath] = argv;
  if (command === "emit-typescript" && firstPath && secondPath === undefined) {
    await emitTypeScript(firstPath);
    return;
  }
  if (command === "verify-python" && firstPath && secondPath) {
    await verifyPython(firstPath, secondPath);
    return;
  }
  throw new Error(
    "usage: ap2-v0.2 emit-typescript <output> | verify-python <typescript-input> <python-input>"
  );
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown conformance failure";
  process.stderr.write(`AP2 TypeScript bridge failed: ${message}\n`);
  process.exitCode = 1;
});

export const AP2_CONFORMANCE_RECEIPT_IDENTITIES = Object.freeze({
  merchantIssuer: FIXED_MERCHANT_RECEIPT_ISSUER,
  paymentIssuer: FIXED_PAYMENT_RECEIPT_ISSUER,
});
