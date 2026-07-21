import assert from "node:assert/strict";
import test from "node:test";

import { decodePaymentRequiredHeader, exactRequestAuthorizationId } from "@kaspa-x402/core";
import type {
  ExactTransactionVerifier,
  ServerChainProvider,
  VoucherVerifier,
} from "@kaspa-x402/server";

import { KaspaTestnet10AddressCodec } from "../adapters/kaspa-x402/address-codec.js";
import { assertPurchaseId, evidenceDigest } from "../purchase/identity.js";
import { SqliteMerchantServerStateStore } from "./merchant-server-store.js";
import { DEMO_NETWORK, DemoMerchantFixture } from "./merchant-fixture.js";

const PAY_TO = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");

test("demo merchant exposes and restores one generic alpha.9 x402 offer", async () => {
  const store = new SqliteMerchantServerStateStore(":memory:");
  const merchant = await DemoMerchantFixture.create({
    merchantId: "https://merchant.example",
    merchantName: "Demo merchant",
    merchantOrigin: "https://merchant.example",
    payTo: PAY_TO,
    paymentScheme: "exact",
    exactProfile: "standard-native",
    amountAtomic: "20000000",
    resource: {
      identity: "resource:demo",
      url: "https://merchant.example/paid-resource",
      method: "GET",
      mediaType: "text/plain; charset=utf-8",
      body: Buffer.from("paid resource\n"),
    },
    store,
    addressCodec: new KaspaTestnet10AddressCodec(),
    chainProvider: chainProvider(),
    voucherVerifier: { verifyVoucher: () => false } satisfies VoucherVerifier,
    exactTransactionVerifier: exactVerifier(),
    serverPublicKey: `02${"11".repeat(32)}`,
  });
  try {
    const offer = await merchant.offer(PURCHASE_ID);
    const header = offer.paymentRequired.headers["PAYMENT-REQUIRED"];
    const parsed = decodePaymentRequiredHeader(header);
    assert.equal(offer.paymentRequired.status, 402);
    assert.equal(parsed.resource.url, "https://merchant.example/paid-resource");
    assert.equal(parsed.accepts.length, 1);
    assert.equal(parsed.accepts[0].scheme, "exact");
    assert.equal(parsed.accepts[0].network, DEMO_NETWORK);
    assert.equal(parsed.accepts[0].amount, "20000000");
    assert.equal((parsed as Record<string, unknown>).ap2, undefined);
    assert.equal(offer.paymentRequirementsDigest, evidenceDigest(Buffer.from(header, "utf8")));

    const restored = await merchant.restoreOffer({
      purchaseId: PURCHASE_ID,
      paymentRequiredHeader: header,
    });
    assert.deepEqual(restored, offer);
  } finally {
    store.close();
  }
});

function chainProvider(): ServerChainProvider {
  return {
    getUtxo: async () => null,
    getVirtualDaaScore: async () => "1",
    estimateClaimFee: async () => "1",
    sendTransaction: async () => ({ transactionId: "44".repeat(32), finality: "accepted" }),
  };
}

function exactVerifier(): ExactTransactionVerifier {
  return {
    verifyExactPayment(request) {
      return {
        transactionId: "44".repeat(32),
        paymentOutput: {
          amount: request.amount,
          scriptPublicKey: request.payToScriptPublicKey,
          address: request.payTo,
        },
        finality: "accepted",
        payerAddress: PAY_TO,
        requestAuthorization: {
          authorizationId: exactRequestAuthorizationId(request.authorization),
          digest: request.authorization.digest,
          inputIndex: request.authorization.inputIndex,
          publicKey: "11".repeat(32),
        },
      };
    },
  };
}
