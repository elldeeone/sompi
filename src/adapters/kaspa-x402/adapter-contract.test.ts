import assert from "node:assert/strict";
import test from "node:test";

import type {
  AddressCodec,
  ChannelSigner,
  ChannelStore,
  DirectModeChannel,
  ExactTransactionPaymentRequest,
  ExactTransactionPaymentResult,
  FundingProvider,
} from "@kaspa-x402/client";
import type { NetworkId } from "@kaspa-x402/core";

import {
  ExactOnlyChannelSigner,
  ExactOnlyChannelStore,
  KaspaTestnet10AddressCodec,
  VaultTreasuryFundingProvider,
} from "./index.js";

const TESTNET: NetworkId = "kaspa:testnet-10";
const TESTNET_ADDRESS = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";
const TX_ID = "11".repeat(32);
const RESERVATION_ID = "22".repeat(32);
const REQUEST_HASH = "33".repeat(32);
const BORROW_TX_ID = "44".repeat(32);
const BORROW_REDEEM_SCRIPT = "51";
const BORROW_SCRIPT_PUBLIC_KEY =
  "0000aa20ce57216285125006ec18197bd8184221cefa559bb0798410d99a5bba5b07cd1d87";

test("exact-only channel adapters satisfy official alpha.6 contracts and fail closed", async () => {
  const store: ChannelStore = new ExactOnlyChannelStore();
  const signer: ChannelSigner = new ExactOnlyChannelSigner();

  assert.deepEqual(await store.loadChannels({ network: TESTNET, status: "active" }), []);
  assert.deepEqual(await store.listRefundableChannels("123"), []);
  await assert.rejects(
    store.saveChannel({} as DirectModeChannel),
    /batch-settlement is disabled/,
  );
  await assert.rejects(store.retireChannel(TX_ID), /batch-settlement is disabled/);
  await assert.rejects(store.deleteChannel(TX_ID), /batch-settlement is disabled/);

  await assert.rejects(signer.generateChannelKey(), /batch-settlement signing is disabled/);
  await assert.rejects(signer.randomSalt(), /batch-settlement signing is disabled/);
  await assert.rejects(signer.randomNonce!(), /batch-settlement signing is disabled/);
  await assert.rejects(signer.signVoucher({} as never), /batch-settlement signing is disabled/);
  await assert.rejects(signer.signRefund!({} as never), /batch-settlement signing is disabled/);
});

test("vendored Kaspa WASM AddressCodec validates and round-trips only testnet-10", () => {
  const codec: AddressCodec = new KaspaTestnet10AddressCodec();
  const serialized = codec.scriptPublicKeyForAddress(TESTNET_ADDRESS, TESTNET);
  assert.equal(serialized, "00002079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac");

  assert.equal(
    codec.encodeScriptAddress({
      network: TESTNET,
      scriptPublicKey: { version: 0, script: serialized.slice(4) },
      serializedScriptPublicKey: serialized,
    }),
    TESTNET_ADDRESS,
  );

  assert.throws(
    () => codec.scriptPublicKeyForAddress(TESTNET_ADDRESS, "kaspa:mainnet"),
    /only kaspa:testnet-10 is enabled/,
  );
  assert.throws(
    () => codec.scriptPublicKeyForAddress("kaspatest:not-an-address", TESTNET),
    /valid Kaspa address/,
  );
  assert.throws(
    () => codec.encodeScriptAddress({
      network: TESTNET,
      scriptPublicKey: { version: 0, script: serialized.slice(4) },
      serializedScriptPublicKey: `0000${"aa".repeat(34)}`,
    }),
    /does not match/,
  );
});

test("vault-treasury provider validates exact request and result around the durable builder", async () => {
  let durableCalls = 0;
  let observedRequest: Readonly<ExactTransactionPaymentRequest> | undefined;
  const provider: FundingProvider = makeProvider(async (request) => {
    durableCalls += 1;
    observedRequest = request;
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.reservation), true);
    return validResult(request);
  });

  assert.equal(provider.networkId, TESTNET);
  assert.equal(provider.sourceKind, "vault-treasury");
  assert.deepEqual(await provider.getPublicIdentity(), { address: TESTNET_ADDRESS, publicKey: "55".repeat(32) });
  assert.equal(await provider.getVirtualDaaScore(), "123456");
  assert.deepEqual(await provider.estimateFees({ network: TESTNET, action: "exact", amount: "20000000" }), {
    feeSompi: "1000",
  });
  assert.deepEqual(await provider.getUtxos([TESTNET_ADDRESS]), []);

  const request = validRequest();
  const result = await provider.payExactTransaction!(request);
  assert.equal(durableCalls, 1);
  assert.equal(observedRequest?.reservation.reservationId, RESERVATION_ID);
  assert.deepEqual(result, validResult(request));
});

test("vault-treasury provider rejects unsupported and tampered exact operations before escape", async () => {
  let durableCalls = 0;
  const provider = makeProvider(async (request) => {
    durableCalls += 1;
    return validResult(request);
  });

  await assert.rejects(
    provider.fundEscrowDeposit({} as never),
    /escrow deposits are disabled/,
  );
  await assert.rejects(provider.sendTransaction("00"), /transaction broadcast is disabled/);
  await assert.rejects(
    provider.estimateFees({ network: TESTNET, action: "refund" }),
    /fee action refund is disabled/,
  );
  await assert.rejects(
    provider.payExactTransaction!({ ...validRequest(), network: "kaspa:mainnet" }),
    /only supports kaspa:testnet-10/,
  );
  await assert.rejects(
    provider.payExactTransaction!({ ...validRequest(), fundingSource: "hot-wallet" }),
    /must require vault-treasury/,
  );
  await assert.rejects(
    provider.payExactTransaction!({
      ...validRequest(),
      reservation: { ...validRequest().reservation, reservationId: "not-a-hash" },
    }),
    /reservation ID/,
  );
  await assert.rejects(
    provider.payExactTransaction!({
      ...validRequest(),
      reservation: { ...validRequest().reservation, reservationExpiresAt: "2020-01-01T00:00:00.000Z" },
    }),
    /has expired/,
  );
  assert.equal(durableCalls, 0);

  const wrongSource = makeProvider(async (request) => ({
    ...validResult(request),
    fundingSource: "hot-wallet",
  }));
  await assert.rejects(wrongSource.payExactTransaction!(validRequest()), /must use vault-treasury/);

  const wrongIndex = makeProvider(async (request) => ({
    ...validResult(request),
    paymentOutputIndex: request.reservation.paymentOutputIndex! + 1,
  }));
  await assert.rejects(wrongIndex.payExactTransaction!(validRequest()), /output index does not match/);

  const wrongId = makeProvider(async (request) => ({
    ...validResult(request),
    transaction: JSON.stringify({ id: "66".repeat(32), inputs: [], outputs: [] }),
  }));
  await assert.rejects(wrongId.payExactTransaction!(validRequest()), /artifact ID does not match/);
});

function makeProvider(
  buildExactTransactionDurably: (
    request: Readonly<ExactTransactionPaymentRequest>,
  ) => Promise<ExactTransactionPaymentResult>,
): VaultTreasuryFundingProvider {
  return new VaultTreasuryFundingProvider({
    getPublicIdentity: async () => ({ address: TESTNET_ADDRESS, publicKey: "55".repeat(32) }),
    getVirtualDaaScore: async () => "123456",
    getUtxos: async () => [],
    estimateFees: async () => ({ feeSompi: "1000" }),
    buildExactTransactionDurably,
    now: () => Date.parse("2030-01-01T00:00:00.000Z"),
  });
}

function validRequest(): ExactTransactionPaymentRequest {
  return {
    network: TESTNET,
    amount: "20000000",
    payTo: TESTNET_ADDRESS,
    requestHash: REQUEST_HASH,
    requiredFinality: "accepted",
    fundingSource: "vault-treasury",
    reservation: {
      templateId: "kaspa-x402-kip10-additive-v1",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      borrowOutpoint: { txid: BORROW_TX_ID, index: 0 },
      borrowAmount: "100000000",
      borrowScriptPublicKey: BORROW_SCRIPT_PUBLIC_KEY,
      borrowRedeemScript: BORROW_REDEEM_SCRIPT,
      additiveThresholdSompi: "10000000",
      paymentOutputIndex: 1,
      reservationId: RESERVATION_ID,
      reservationExpiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
}

function validResult(request: ExactTransactionPaymentRequest): ExactTransactionPaymentResult {
  return {
    transaction: JSON.stringify({ id: TX_ID, inputs: [], outputs: [] }),
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    transactionId: TX_ID,
    paymentOutputIndex: request.reservation.paymentOutputIndex!,
    payerAddress: TESTNET_ADDRESS,
    fundingSource: "vault-treasury",
  };
}
