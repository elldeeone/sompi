import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ExactTransactionPaymentRequest } from "@kaspa-x402/client";
import {
  buildKip10AdditiveRedeemScript,
  buildKip10AdditiveBorrowArgs,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

import {
  Transaction,
  calculateTransactionMass,
  payToScriptHashSignatureScript,
} from "../../kaspa-wasm.js";
import { assertPurchaseId, createPaymentIdentifier } from "../../purchase/identity.js";
import {
  ExactTransactionBuilderError,
  Kip10ExactTransactionBuilder,
  SOMPI_EXACT_FEE_POLICY,
  type BuildKip10ExactTransactionInput,
} from "./exact-transaction-builder.js";
import { StagingKeyStore } from "./staging-key-store.js";

const FIXED_PRIVATE_KEY = "01".padStart(64, "0");
const OWNER_PUBLIC_KEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const PAYMENT_IDENTIFIER = createPaymentIdentifier(PURCHASE_ID, 1);
const MERCHANT_ADDRESS = "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const BORROW_TXID = "22".repeat(32);
const STAGING_TXID = "33".repeat(32);
const FIXED_TXID = "21ba817bbbd3c8f27778e6847a0a282c3618877ae8614eb7099631bbd6e55b44";
test("fixed vector builds the characterized two-input KIP-10 additive exact transaction", async () => {
  await withFixture(async ({ builder, input }) => {
    const first = await builder.build(input);
    const second = await builder.build(input);
    assert.equal(second.transactionId, first.transactionId);
    assert.equal(first.transactionId, FIXED_TXID);
    assert.equal(first.transactionEncoding, "kaspa-sdk-safe-json-v2.0.0");
    assert.equal(first.paymentOutputIndex, 1);
    assert.equal(first.fundingSource, "vault-treasury");
    assert.equal(
      first.payerAddress,
      "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd"
    );

    const transaction = JSON.parse(first.transaction) as {
      id: string;
      version: number;
      inputs: Array<Record<string, unknown>>;
      outputs: Array<Record<string, unknown>>;
      subnetworkId: string;
    };
    assert.equal(transaction.id, FIXED_TXID);
    assert.equal(transaction.version, 1);
    assert.equal(transaction.subnetworkId, "00".repeat(20));
    assert.equal(transaction.inputs.length, 2);
    assert.equal(transaction.outputs.length, 2);
    assert.deepEqual(
      transaction.inputs.map((entry) => entry.computeBudget),
      [10, 10]
    );
    assert.equal(transaction.inputs[0].transactionId, BORROW_TXID);
    assert.equal(
      transaction.inputs[0].signatureScript,
      payToScriptHashSignatureScript(
        input.request.reservation.borrowRedeemScript!,
        buildKip10AdditiveBorrowArgs()
      )
    );
    assert.equal(transaction.inputs[1].transactionId, STAGING_TXID);
    assert.match(String(transaction.inputs[1].signatureScript), /^[a-f0-9]{132}$/);
    assert.equal(transaction.outputs[0].value, "110000000");
    assert.equal(
      transaction.outputs[0].scriptPublicKey,
      input.request.reservation.borrowScriptPublicKey
    );
    assert.equal(transaction.outputs[1].value, "20000000");
    assert.equal(
      transaction.outputs[1].scriptPublicKey,
      "000020bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9ac"
    );
    assert.equal(SOMPI_EXACT_FEE_POLICY.feeSompi, "2000000");
    assert.equal(SOMPI_EXACT_FEE_POLICY.feeRateSompiPerGram, 100);
    const signed = Transaction.deserializeFromSafeJSON(first.transaction);
    try {
      const requiredFee = (
        calculateTransactionMass("testnet-10", signed) +
        BigInt(
          SOMPI_EXACT_FEE_POLICY.inputComputeBudget *
          2 *
          SOMPI_EXACT_FEE_POLICY.computeBudgetMassPerUnit
        )
      ) * BigInt(SOMPI_EXACT_FEE_POLICY.feeRateSompiPerGram);
      assert.ok(1_000_000n < requiredFee, "the retired fixture fee must remain below the live floor");
      assert.ok(BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi) >= requiredFee);
    } finally {
      signed.free();
    }

    assert.equal(
      (await builder.build({ ...input, expectedTransactionId: FIXED_TXID })).transactionId,
      FIXED_TXID
    );
    await assert.rejects(
      builder.build({ ...input, expectedTransactionId: "99".repeat(32) }),
      /changed during recovery/
    );
  });
});

test("fixed-v2 exact builder rejects overfunded staging instead of creating change", async () => {
  await withFixture(async ({ builder, input }) => {
    await assert.rejects(
      builder.build({
        ...input,
        staging: { ...input.staging, amountAtomic: "32000001" },
        additionalCostCeilingAtomic: "12050001",
      }),
      /fixed-v2 exact staging/
    );
    await assert.rejects(
      builder.build({
        ...input,
        staging: { ...input.staging, amountAtomic: "42000000" },
        additionalCostCeilingAtomic: "22050000",
      }),
      /fixed-v2 exact staging/
    );
  });
});

test("exact builder validates the complete additional-cost and gross treasury bounds", async () => {
  await withFixture(async ({ builder, input }) => {
    await assert.rejects(
      builder.build({ ...input, additionalCostCeilingAtomic: "12049999" }),
      /complete additional cost exceeds/
    );
    await assert.rejects(
      builder.build({
        ...input,
        staging: { ...input.staging, amountAtomic: "31999999" },
      }),
      /cannot fund price, threshold, and exact fee/
    );
  });
});

test("exact builder rejects request, reservation, and KIP-10 template substitutions", async () => {
  await withFixture(async ({ builder, input }) => {
    const request = input.request;
    const reservation = request.reservation;
    const cases: Array<{ input: BuildKip10ExactTransactionInput; pattern: RegExp }> = [
      {
        input: { ...input, request: { ...request, network: "kaspa:mainnet" } },
        pattern: /only kaspa:testnet-10/,
      },
      {
        input: { ...input, request: { ...request, fundingSource: "hot-wallet" } },
        pattern: /vault-treasury/,
      },
      {
        input: { ...input, request: { ...request, requestHash: "AA".repeat(32) } },
        pattern: /request hash/,
      },
      {
        input: {
          ...input,
          request: { ...request, reservation: { ...reservation, templateId: "other" as never } },
        },
        pattern: /template is unsupported/,
      },
      {
        input: {
          ...input,
          request: {
            ...request,
            reservation: { ...reservation, transactionEncoding: "other" as never },
          },
        },
        pattern: /encoding is unsupported/,
      },
      {
        input: {
          ...input,
          request: { ...request, reservation: { ...reservation, paymentOutputIndex: 0 } },
        },
        pattern: /must be index 1/,
      },
      {
        input: {
          ...input,
          request: {
            ...request,
            reservation: { ...reservation, additiveThresholdSompi: "9999999" },
          },
        },
        pattern: /threshold is below/,
      },
      {
        input: {
          ...input,
          request: {
            ...request,
            reservation: { ...reservation, additiveThresholdSompi: "20000000" },
          },
        },
        pattern: /do not match reservation facts/,
      },
      {
        input: {
          ...input,
          request: { ...request, reservation: { ...reservation, borrowRedeemScript: "51" } },
        },
        pattern: /not the pinned KIP-10/,
      },
      {
        input: {
          ...input,
          request: {
            ...request,
            reservation: { ...reservation, borrowScriptPublicKey: `0000${"aa".repeat(34)}` },
          },
        },
        pattern: /do not match reservation facts/,
      },
      {
        input: {
          ...input,
          request: {
            ...request,
            reservation: { ...reservation, reservationExpiresAt: "2029-01-01T00:00:00.000Z" },
          },
        },
        pattern: /invalid or expired/,
      },
    ];
    for (const candidate of cases) {
      await assert.rejects(builder.build(candidate.input), candidate.pattern);
    }
  });
});

test("exact builder rejects observed staging and key-reference tampering before signing", async () => {
  await withFixture(async ({ builder, input }) => {
    await assert.rejects(
      builder.build({
        ...input,
        staging: { ...input.staging, address: MERCHANT_ADDRESS },
      }),
      /address and script public key do not match/
    );
    await assert.rejects(
      builder.build({
        ...input,
        staging: { ...input.staging, scriptPublicKey: `0000${"aa".repeat(34)}` },
      }),
      /address and script public key do not match/
    );
    await assert.rejects(
      builder.build({
        ...input,
        staging: { ...input.staging, keyReference: `stg_v1_${"A".repeat(43)}` },
      }),
      /bound to different Purchase facts/
    );
    await assert.rejects(
      builder.build({
        ...input,
        staging: {
          ...input.staging,
          outpoint: { ...input.request.reservation.borrowOutpoint! },
        },
      }),
      /must be distinct/
    );
  });
});

interface Fixture {
  builder: Kip10ExactTransactionBuilder;
  input: BuildKip10ExactTransactionInput;
}

async function withFixture(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-exact-builder-"));
  try {
    const store = new StagingKeyStore({
      directory: path.join(root, "keys"),
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
      generatePrivateKey: () => FIXED_PRIVATE_KEY,
    });
    const key = store.create({ purchaseId: PURCHASE_ID, paymentIdentifier: PAYMENT_IDENTIFIER });
    const borrowRedeemScript = buildKip10AdditiveRedeemScript({
      ownerPublicKey: OWNER_PUBLIC_KEY,
      amount: "10000000",
    }).toLowerCase();
    const borrowScriptPublicKey = serializedScriptPublicKey(
      kip10AdditiveScriptPublicKey({
        ownerPublicKey: OWNER_PUBLIC_KEY,
        amount: "10000000",
      })
    ).toLowerCase();
    const request: ExactTransactionPaymentRequest = {
      network: "kaspa:testnet-10",
      amount: "20000000",
      payTo: MERCHANT_ADDRESS,
      requestHash: "44".repeat(32),
      requiredFinality: "accepted",
      fundingSource: "vault-treasury",
      reservation: {
        templateId: "kaspa-x402-kip10-additive-v1",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        borrowOutpoint: { txid: BORROW_TXID, index: 0 },
        borrowAmount: "100000000",
        borrowScriptPublicKey,
        borrowRedeemScript,
        additiveThresholdSompi: "10000000",
        paymentOutputIndex: 1,
        reservationId: "55".repeat(32),
        reservationExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    const input: BuildKip10ExactTransactionInput = {
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      request,
      staging: {
        outpoint: { txid: STAGING_TXID, index: 1 },
        amountAtomic: "32000000",
        scriptPublicKey: key.scriptPublicKey,
        address: key.address,
        blockDaaScore: "123",
        keyReference: key.keyReference,
      },
      additionalCostCeilingAtomic: "12050000",
      stagingTransactionFeeAtomic: "50000",
    };
    await action({
      builder: new Kip10ExactTransactionBuilder({
        keyStore: store,
        now: () => Date.parse("2030-01-01T00:00:00.000Z"),
      }),
      input,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
