import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  channelId,
  hexToBytes,
  sha256Hex,
  voucherDigest,
  type ChannelConfig,
  type Hash32Hex,
} from "@kaspa-x402/core";
import {
  buildEscrowRedeemScript,
  deriveEscrowAddress,
  escrowScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  DirectModeServer,
  MemoryServerChannelStore,
  type ServerChainProvider,
  type ServerChannelRecord,
} from "@kaspa-x402/server";

import { Transaction } from "../../kaspa-wasm.js";
import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import { KaspaX402BatchClaimBuilder } from "./batch-claim-builder.js";
import { SecureBatchChannelSigner } from "./batch-channel-signer.js";

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const ACTIVE_TXID = "55".repeat(32) as Hash32Hex;

test("public alpha.8 claim builder and DirectModeServer rotate one accepted continuation", async () => {
  await withClaimFixture("accepted", async ({ server, store, channel }) => {
    const preview = await server.previewClaim(channel.channelId);
    assert.equal(preview.claimable, true);
    assert.equal(preview.claimAmount, "200000");
    assert.equal(preview.estimatedFee, "100000");

    const result = await server.executeClaim(channel.channelId);
    assert.equal(result.accepted, true);
    assert.equal(result.finality, "accepted");
    assert.equal(result.channel.claimedCumulativeAmount, "200000");
    assert.equal(result.channel.fundingAmount, "800000");
    assert.equal(result.channel.activeOutpoint.index, 1);
    assert.equal(result.channel.activeOutpoint.txid, result.transactionId);
    assert.equal((await store.loadOpenClaimAttempt(channel.channelId)), undefined);
  });
});

test("broadcast-only claim remains durable and recovers without rebuilding or rebroadcasting", async () => {
  await withClaimFixture("broadcast", async ({ server, store, channel, sends }) => {
    const first = await server.executeClaim(channel.channelId);
    assert.equal(first.accepted, false);
    assert.equal(first.finality, "broadcast");
    assert.equal(sends.length, 1);
    const open = await store.loadOpenClaimAttempt(channel.channelId);
    assert.equal(open?.status, "broadcast");
    assert.equal(open?.transactionId, first.transactionId);

    const recovered = await server.recoverAcceptedClaim(channel.channelId, {
      transactionId: first.transactionId,
      finality: "accepted",
    });
    assert.equal(recovered.accepted, true);
    assert.equal(recovered.channel.claimedCumulativeAmount, "200000");
    assert.equal(recovered.channel.fundingAmount, "800000");
    assert.equal(sends.length, 1);
    assert.equal((await store.loadOpenClaimAttempt(channel.channelId)), undefined);
  });
});

async function withClaimFixture(
  sendFinality: "broadcast" | "accepted",
  run: (input: {
    server: DirectModeServer;
    store: MemoryServerChannelStore;
    channel: ServerChannelRecord;
    sends: readonly string[];
  }) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-batch-claim-"));
  fs.chmodSync(root, 0o700);
  const signer = new SecureBatchChannelSigner(
    root,
    () => 1_800_000_000_000,
    deterministicEntropy()
  );
  try {
    const client = await signer.ensureChannelKey("batch-claim-client");
    const merchant = await signer.ensureChannelKey("batch-claim-merchant");
    const codec = new KaspaTestnet10AddressCodec();
    const config: ChannelConfig = {
      network: "kaspa:testnet-10",
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v1",
      clientPublicKey: client.publicKey as Hash32Hex,
      serverPublicKey: merchant.publicKey as Hash32Hex,
      payTo: ADDRESS,
      refundAddress: ADDRESS,
      refundTimeoutDaa: "500000000",
      salt: "44".repeat(32) as Hash32Hex,
    };
    const payout = codec.scriptPublicKeyForAddress(ADDRESS, "kaspa:testnet-10");
    const params = {
      clientPublicKey: config.clientPublicKey,
      serverPublicKey: config.serverPublicKey,
      network: "kaspa:testnet-10" as const,
      payoutScriptPublicKeyHash: sha256Hex(hexToBytes(payout)),
      refundScriptPublicKeyHash: sha256Hex(hexToBytes(payout)),
      timeoutDaa: config.refundTimeoutDaa,
    };
    const script = escrowScriptPublicKey(params);
    const activeScriptPublicKey = `${script.version.toString(16).padStart(4, "0")}${script.script}`;
    const id = channelId(config);
    const voucherAmount = "200000";
    const voucherSignature = signer.signDigest(client.publicKey, voucherDigest({
      network: "kaspa:testnet-10",
      activeScriptPublicKey,
      outpoint: { txid: ACTIVE_TXID, index: 0 },
      amount: voucherAmount,
    }));
    const channel: ServerChannelRecord = {
      channelId: id,
      channelConfig: config,
      escrowAddress: deriveEscrowAddress(
        params,
        (input) => codec.encodeScriptAddress(input)
      ),
      activeOutpoint: { txid: ACTIVE_TXID, index: 0 },
      activeScriptPublicKey,
      fundingAmount: "1000000",
      chargedCumulativeAmount: "200000",
      claimedCumulativeAmount: "0",
      signedMaxClaimable: voucherAmount,
      voucherSignature: voucherSignature as never,
      status: "active",
    };
    assert.equal(buildEscrowRedeemScript(params).length > 0, true);
    const store = new MemoryServerChannelStore();
    await store.saveChannel(channel);
    const sends: string[] = [];
    let continuationTxid: string | undefined;
    const fees = { estimateClaimFee: async () => "100000" as const };
    const chain: ServerChainProvider = {
      getVirtualDaaScore: async () => "400000000",
      estimateClaimFee: fees.estimateClaimFee,
      sendTransaction: async (safeJson) => {
        const transaction = Transaction.deserializeFromSafeJSON(safeJson);
        try {
          continuationTxid = String(transaction.finalize()).toLowerCase();
          sends.push(continuationTxid);
          return { transactionId: continuationTxid as Hash32Hex, finality: sendFinality };
        } finally {
          transaction.free();
        }
      },
      getUtxo: async (outpoint) => {
        if (
          outpoint.txid !== continuationTxid || outpoint.index !== 1 ||
          continuationTxid === undefined
        ) return null;
        return {
          outpoint,
          amount: "800000",
          scriptPublicKey: activeScriptPublicKey,
          finality: "accepted",
        };
      },
    };
    const server = new DirectModeServer({
      network: "kaspa:testnet-10",
      asset: "KAS",
      payTo: ADDRESS,
      serverPublicKey: config.serverPublicKey,
      minDepositSompi: "1",
      amount: "200000",
      refundTimeoutDaa: config.refundTimeoutDaa,
      maxTimeoutSeconds: 60,
      store,
      chainProvider: chain,
      addressCodec: codec,
      voucherVerifier: { verifyVoucher: () => true },
      claimBuilder: new KaspaX402BatchClaimBuilder(signer, fees),
      acceptedFinality: "accepted",
      requirePaymentIdentifier: true,
      allowMainnet: false,
    });
    await run({ server, store, channel, sends });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function deterministicEntropy(): () => Uint8Array {
  let sequence = 1;
  return () => {
    const bytes = new Uint8Array(32);
    bytes[31] = sequence++;
    return bytes;
  };
}
