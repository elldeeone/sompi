import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ExactTransactionPaymentRequest } from "@kaspa-x402/client";
import {
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

import { ScriptPublicKey, Transaction, addressFromScriptPublicKey } from "../../kaspa-wasm.js";
import { assertPurchaseId, createPaymentIdentifier } from "../../purchase/identity.js";
import {
  ExactTransactionBuilder,
  SOMPI_EXACT_FEE_POLICY,
  type BuildExactTransactionInput,
} from "./exact-transaction-builder.js";
import { StagingKeyStore } from "./staging-key-store.js";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const FIXED_PRIVATE_KEY = "01".padStart(64, "0");
const OWNER_PUBLIC_KEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const PAYMENT_IDENTIFIER = createPaymentIdentifier(PURCHASE_ID, 1);
const HEAD_TXID = "22".repeat(32);
const STAGING_TXID = "33".repeat(32);

test("standard-native pays the advertised amount once in a version-0 transaction", async () => {
  await withFixture("standard-native", async ({ builder, input }) => {
    const result = await builder.build(input);
    const repeated = await builder.build(input);
    assert.equal(repeated.transactionId, result.transactionId);
    assert.equal(result.paymentOutputIndex, 0);
    assert.equal(result.authorization.inputIndex, 0);
    assert.equal(result.authorization.expiresAt, input.request.authorizationExpiresAt);

    const transaction = parseTransaction(result.transaction);
    assert.equal(transaction.version, 0);
    assert.equal(transaction.inputs.length, 1);
    assert.equal(transaction.outputs.length, 1);
    assert.equal(transaction.outputs[0]?.value, input.request.amount);
    assert.equal(transaction.outputs[0]?.scriptPublicKey, input.request.payToScriptPublicKey);
    assert.equal(transaction.inputs[0]?.transactionId, STAGING_TXID);
    assert.equal(transaction.inputs[0]?.sigOpCount, 1);
    assert.equal(transaction.inputs[0]?.computeBudget, 0);
    assert.equal(BigInt(input.staging.amountAtomic) - BigInt(input.request.amount), 2_000_000n);
  });
});

test("additive makes the successor delta the sole merchant payment", async () => {
  await withFixture("additive", async ({ builder, input }) => {
    const result = await builder.build(input);
    const transaction = parseTransaction(result.transaction);
    assert.equal(transaction.version, 1);
    assert.equal(transaction.inputs.length, 2);
    assert.equal(transaction.outputs.length, 1);
    assert.equal(transaction.inputs[0]?.transactionId, HEAD_TXID);
    assert.equal(transaction.inputs[0]?.computeBudget, 0);
    assert.equal(transaction.inputs[1]?.transactionId, STAGING_TXID);
    assert.equal(transaction.inputs[1]?.computeBudget, 10);
    assert.equal(transaction.outputs[0]?.value, "120000000");
    assert.equal(transaction.outputs[0]?.scriptPublicKey, input.request.payToScriptPublicKey);
    assert.equal(result.paymentOutputIndex, 0);
    assert.equal(result.authorization.inputIndex, 1);

    const merchantGain =
      BigInt(String(transaction.outputs[0]?.value)) - BigInt(input.request.head!.headAmount);
    assert.equal(merchantGain, BigInt(input.request.amount));
    assert.equal(transaction.outputs.some((output) => output.value === input.request.amount), false);
  });
});

test("builder enforces exact staging cost and the caller authorization ceiling", async () => {
  await withFixture("standard-native", async ({ builder, input }) => {
    await assert.rejects(
      builder.build({
        ...input,
        staging: { ...input.staging, amountAtomic: "22000001" },
      }),
      /must equal price plus the bounded fee/
    );
    await assert.rejects(
      builder.build({ ...input, additionalCostCeilingAtomic: "2049999" }),
      /complete additional cost exceeds authorization/
    );
    await assert.rejects(
      builder.build({ ...input, expectedTransactionId: "99".repeat(32) }),
      /changed during recovery/
    );
  });
});

test("profile-specific head facts fail closed before signing", async () => {
  await withFixture("standard-native", async ({ builder, input }) => {
    const additive = await fixtureRequest("additive");
    await assert.rejects(
      builder.build({ ...input, request: { ...input.request, head: additive.head } }),
      /must not include an additive head/
    );
  });
  await withFixture("additive", async ({ builder, input }) => {
    await assert.rejects(
      builder.build({
        ...input,
        request: {
          ...input.request,
          amount: "9999999",
        },
        staging: { ...input.staging, amountAtomic: "11999999" },
      }),
      /below the additive threshold/
    );
    await assert.rejects(
      builder.build({
        ...input,
        request: {
          ...input.request,
          head: { ...input.request.head!, challengeExpiresAt: "2029-01-01T00:00:00.000Z" },
        },
      }),
      /invalid or expired/
    );
    await assert.rejects(
      builder.build({
        ...input,
        staging: { ...input.staging, outpoint: { ...input.request.head!.expectedHeadOutpoint } },
      }),
      /must be distinct/
    );
  });
});

interface ParsedTransaction {
  version: number;
  inputs: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
}

function parseTransaction(serialized: string): ParsedTransaction {
  const sdk = Transaction.deserializeFromSafeJSON(serialized);
  try {
    const parsed = JSON.parse(sdk.serializeToSafeJSON()) as ParsedTransaction;
    assert.equal(parsed.outputs.length > 0, true);
    return parsed;
  } finally {
    sdk.free();
  }
}

interface Fixture {
  builder: ExactTransactionBuilder;
  input: BuildExactTransactionInput;
}

async function withFixture(
  profile: ExactTransactionPaymentRequest["profile"],
  action: (fixture: Fixture) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-exact-builder-"));
  try {
    const keyStore = new StagingKeyStore({
      directory: path.join(root, "keys"),
      now: () => NOW,
      generatePrivateKey: () => FIXED_PRIVATE_KEY,
    });
    const key = keyStore.create({ purchaseId: PURCHASE_ID, paymentIdentifier: PAYMENT_IDENTIFIER });
    const request = await fixtureRequest(profile);
    const input: BuildExactTransactionInput = {
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      request,
      staging: {
        outpoint: { txid: STAGING_TXID, index: 1 },
        amountAtomic: "22000000",
        scriptPublicKey: key.scriptPublicKey,
        address: key.address,
        blockDaaScore: "123",
        keyReference: key.keyReference,
      },
      additionalCostCeilingAtomic: "2050000",
      stagingTransactionFeeAtomic: "50000",
    };
    await action({
      builder: new ExactTransactionBuilder({ keyStore, now: () => NOW }),
      input,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function fixtureRequest(
  profile: ExactTransactionPaymentRequest["profile"]
): Promise<ExactTransactionPaymentRequest> {
  const redeemScript = buildKip10AdditiveRedeemScript({
    ownerPublicKey: OWNER_PUBLIC_KEY,
    amount: "10000000",
  }).toLowerCase();
  const scriptPublicKey = serializedScriptPublicKey(
    kip10AdditiveScriptPublicKey({ ownerPublicKey: OWNER_PUBLIC_KEY, amount: "10000000" })
  ).toLowerCase();
  const sdkScript = new ScriptPublicKey(0, scriptPublicKey.slice(4));
  const merchantAddress = addressFromScriptPublicKey(sdkScript, "testnet-10")?.toString();
  sdkScript.free();
  assert.ok(merchantAddress);
  return {
    network: "kaspa:testnet-10",
    profile,
    origin: "https://merchant.example",
    resourceUrl: "https://merchant.example/report",
    amount: "20000000",
    payTo: merchantAddress,
    payToScriptPublicKey: scriptPublicKey,
    paymentOutputIndex: 0,
    requestHash: "44".repeat(32),
    paymentRequirementsHash: "55".repeat(32),
    authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    requiredFinality: "accepted",
    fundingSource: "vault-treasury",
    ...(profile === "standard-native"
      ? {}
      : {
          head: {
            headId: "66".repeat(32),
            headVersion: "0",
            expectedHeadOutpoint: { txid: HEAD_TXID, index: 0 },
            headAmount: "100000000",
            headScriptPublicKey: scriptPublicKey,
            headRedeemScript: redeemScript,
            additiveThresholdSompi: "10000000",
            challengeId: "77".repeat(32),
            challengeExpiresAt: "2099-01-01T00:00:00.000Z",
          },
        }),
  };
}

assert.equal(SOMPI_EXACT_FEE_POLICY.feeSompi, "2000000");
