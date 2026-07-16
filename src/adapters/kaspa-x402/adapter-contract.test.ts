import assert from "node:assert/strict";
import test from "node:test";

import type {
  AddressCodec,
  ExactTransactionPaymentRequest,
  ExactTransactionPaymentResult,
  FundingProvider,
} from "@kaspa-x402/client";
import { exactRequestAuthorizationDigest, type NetworkId } from "@kaspa-x402/core";

import { KaspaTestnet10AddressCodec, VaultTreasuryFundingProvider } from "./index.js";

const TESTNET: NetworkId = "kaspa:testnet-10";
const TESTNET_ADDRESS =
  "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";
const TESTNET_SCRIPT =
  "00002079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac";
const TX_ID = "11".repeat(32);
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

test("AddressCodec is pinned to testnet-10 and round-trips canonical scripts", () => {
  const codec: AddressCodec = new KaspaTestnet10AddressCodec();
  assert.equal(codec.scriptPublicKeyForAddress(TESTNET_ADDRESS, TESTNET), TESTNET_SCRIPT);
  assert.equal(
    codec.encodeScriptAddress({
      network: TESTNET,
      scriptPublicKey: { version: 0, script: TESTNET_SCRIPT.slice(4) },
      serializedScriptPublicKey: TESTNET_SCRIPT,
    }),
    TESTNET_ADDRESS
  );
  assert.throws(
    () => codec.scriptPublicKeyForAddress(TESTNET_ADDRESS, "kaspa:mainnet"),
    /only kaspa:testnet-10 is enabled/
  );
});

test("attempt funding provider requires authorization before one immutable exact artifact", async () => {
  const authorized: ExactTransactionPaymentRequest[] = [];
  const built: ExactTransactionPaymentRequest[] = [];
  const provider: FundingProvider = makeProvider(
    async (request) => { authorized.push(structuredClone(request)); },
    async (request) => { built.push(structuredClone(request)); return validResult(request); }
  );
  const request = validRequest();
  await assert.rejects(provider.payExactTransaction!(request), /was not authorized before signing/);
  await provider.authorizeExactPayment!(request);
  const result = await provider.payExactTransaction!(request);
  assert.equal(result.transactionId, TX_ID);
  assert.equal(result.paymentOutputIndex, 0);
  assert.equal(authorized.length, 1);
  assert.equal(built.length, 1);
  await assert.rejects(
    provider.authorizeExactPayment!({ ...request, requestHash: "66".repeat(32) }),
    /cannot authorize a different exact request/
  );
});

test("attempt funding provider rejects non-exact authority and profile substitutions", async () => {
  let escaped = 0;
  const provider = makeProvider(
    async () => { escaped += 1; },
    async (request) => { escaped += 1; return validResult(request); }
  );
  await assert.rejects(provider.fundEscrowDeposit({} as never), /outside the exact attempt provider/);
  await assert.rejects(provider.sendTransaction("00"), /merchant or facilitator submits/);
  await assert.rejects(
    provider.authorizeExactPayment!({ ...validRequest(), network: "kaspa:mainnet" }),
    /only supports kaspa:testnet-10/
  );
  await assert.rejects(
    provider.authorizeExactPayment!({ ...validRequest(), fundingSource: "hot-wallet" }),
    /must require vault-treasury/
  );
  await assert.rejects(
    provider.authorizeExactPayment!({
      ...validRequest(),
      profile: "additive",
    }),
    /requires a head challenge/
  );
  assert.equal(escaped, 0);
});

function makeProvider(
  authorizeExactPayment: (request: Readonly<ExactTransactionPaymentRequest>) => Promise<void>,
  buildExactTransactionDurably: (
    request: Readonly<ExactTransactionPaymentRequest>
  ) => Promise<ExactTransactionPaymentResult>
): VaultTreasuryFundingProvider {
  return new VaultTreasuryFundingProvider({
    getPublicIdentity: async () => ({ address: TESTNET_ADDRESS, publicKey: "55".repeat(32) }),
    getVirtualDaaScore: async () => "123456",
    getUtxos: async () => [],
    estimateFees: async () => ({ feeSompi: "1000" }),
    authorizeExactPayment,
    buildExactTransactionDurably,
    now: () => NOW,
  });
}

function validRequest(): ExactTransactionPaymentRequest {
  return {
    network: TESTNET,
    profile: "standard-native",
    origin: "https://merchant.example",
    resourceUrl: "https://merchant.example/report",
    amount: "20000000",
    payTo: TESTNET_ADDRESS,
    payToScriptPublicKey: TESTNET_SCRIPT,
    paymentOutputIndex: 0,
    requestHash: "33".repeat(32),
    paymentRequirementsHash: "44".repeat(32),
    authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    requiredFinality: "accepted",
    fundingSource: "vault-treasury",
  };
}

function validResult(request: ExactTransactionPaymentRequest): ExactTransactionPaymentResult {
  const authorization = {
    version: "kaspa-x402-exact-request-authorization-v1" as const,
    inputIndex: 0,
    expiresAt: request.authorizationExpiresAt,
    digest: exactRequestAuthorizationDigest({
      network: request.network,
      profile: request.profile,
      transactionId: TX_ID,
      paymentOutputIndex: 0,
      amount: request.amount,
      payTo: request.payTo,
      payToScriptPublicKey: request.payToScriptPublicKey,
      paymentRequirementsHash: request.paymentRequirementsHash,
      requestHash: request.requestHash,
      inputIndex: 0,
      expiresAt: request.authorizationExpiresAt,
    }),
    signature: "55".repeat(64),
  };
  return {
    transaction: JSON.stringify({ id: TX_ID, inputs: [], outputs: [] }),
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    transactionId: TX_ID,
    paymentOutputIndex: 0,
    authorization,
    payerAddress: TESTNET_ADDRESS,
    fundingSource: "vault-treasury",
  };
}
