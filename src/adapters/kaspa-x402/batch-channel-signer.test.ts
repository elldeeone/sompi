import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { DirectModeChannel } from "@kaspa-x402/client";
import type { Hash32Hex } from "@kaspa-x402/core";

import { SecureBatchChannelSigner } from "./batch-channel-signer.js";

test("batch signer persists owner-only keys and signs without exposing them", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-batch-keys-"));
  try {
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0);
    const signer = new SecureBatchChannelSigner(directory, () => 1_800_000_000_000, () => secret);
    const key = await signer.generateChannelKey();
    assert.equal("privateKey" in key, false);
    const entries = fs.readdirSync(directory);
    assert.equal(entries.length, 1);
    assert.equal(fs.statSync(path.join(directory, entries[0]!)).mode & 0o777, 0o600);
    const digest = "aa".repeat(32) as Hash32Hex;
    const signature = await signer.signVoucher({
      digest,
      preimage: "bb" as never,
      amount: "1",
      channel: channel(key.publicKey),
    });
    assert.equal(
      schnorr.verify(
        Buffer.from(signature, "hex"),
        Buffer.from(digest, "hex"),
        Buffer.from(key.publicKey, "hex")
      ),
      true
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("batch signer reuses the durable key bound to a capitalization operation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-batch-operation-key-"));
  let generated = 0;
  try {
    const signer = new SecureBatchChannelSigner(directory, () => 1_800_000_000_000, () => {
      generated += 1;
      return Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? generated : 0);
    });
    const digest = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const first = await signer.ensureChannelKey("batch-channel.demo", digest);
    const second = await signer.ensureChannelKey("batch-channel.demo", digest);
    assert.deepEqual(second, first);
    assert.equal(generated, 1);
    assert.equal(fs.readdirSync(directory).length, 2);
    await assert.rejects(
      signer.ensureChannelKey(
        "batch-channel.demo",
        "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ),
      /operation binding/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function channel(publicKey: Hash32Hex): DirectModeChannel {
  return {
    id: "11".repeat(32) as Hash32Hex,
    origin: "https://merchant.example",
    config: {
      network: "kaspa:testnet-10", asset: "KAS", templateId: "kaspa-x402-escrow-v1",
      clientPublicKey: publicKey, serverPublicKey: "22".repeat(32) as Hash32Hex,
      payTo: "kaspatest:q", refundAddress: "kaspatest:r", refundTimeoutDaa: "1",
      salt: "33".repeat(32) as Hash32Hex,
    },
    clientPublicKey: publicKey,
    serverPublicKey: "22".repeat(32) as Hash32Hex,
    activeOutpoint: { txid: "44".repeat(32) as Hash32Hex, index: 0 },
    activeScriptPublicKey: "000051",
    escrowAddress: "kaspatest:e",
    fundingSource: "vault-treasury",
    fundingAmount: "10", chargedCumulativeAmount: "0", claimedCumulativeAmount: "0",
    signedCumulativeAmount: "0", refundTimeoutDaa: "1",
    templateId: "kaspa-x402-escrow-v1", status: "active",
  };
}
