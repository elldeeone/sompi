import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  Transaction,
  payToScriptHashScript,
} from "./kaspa-wasm.js";
import { buildRedeemScript } from "./vault/template.js";
import { KaspaWallet } from "./wallet.js";
import {
  VaultManager,
  VaultPreparationError,
  generateOwnerKey,
  vaultStaticConfigurationDigest,
} from "./vault.js";

test("vault staging is prepared, submitted, observed, and committed at separate durable edges", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-prepared-"));
  fs.chmodSync(directory, 0o700);
  const wallet = new KaspaWallet({
    networkId: "testnet-10",
    dataDir: path.join(directory, "wallet"),
  });
  const vault = new VaultManager(directory, "testnet-10");
  const created = vault.create(500_000_000n, generateOwnerKey().publicKey, 36_000n);
  const covenantId = "aa".repeat(32);
  const fundingTxid = "bb".repeat(32);
  const funded = {
    ...created,
    covenantId,
    currentOutpoint: { txid: fundingTxid, index: 0 },
  };
  const configPath = path.join(directory, "vault", "config.json");
  fs.writeFileSync(configPath, JSON.stringify(funded, null, 2), { mode: 0o600 });

  let vaultAmount = 400_000_000n;
  const vaultScript = payToScriptHashScript(
    buildRedeemScript(
      funded.agentPublic,
      funded.ownerPublic,
      BigInt(funded.maxOutflowSompi),
      BigInt(funded.windowSizeDaa),
      {
        windowStartDaa: BigInt(funded.windowStartDaa),
        spentInWindowSompi: BigInt(funded.spentInWindowSompi),
      }
    )
  );
  let submitted: Transaction | undefined;
  let submitCalls = 0;
  let failPoint: "wallet.client" | "getUtxosByAddresses" | "getFeeEstimate" | "getServerInfo" | undefined;
  (wallet as any).client = async () => ({
    getUtxosByAddresses: async (addresses: string[]) => {
      if (failPoint === "getUtxosByAddresses") {
        failPoint = undefined;
        throw new Error("injected pre-sign getUtxosByAddresses timeout");
      }
      if (addresses.length === 1 && addresses[0] === funded.address) {
        return {
          entries: [
            {
              outpoint: { transactionId: fundingTxid, index: 0 },
              amount: vaultAmount,
              scriptPublicKey: vaultScript,
              blockDaaScore: 520_928_580n,
              isCoinbase: false,
              covenantId,
            },
          ],
        };
      }
      if (!submitted) return { entries: [] };
      const txid = String(submitted.finalize());
      return {
        entries: [
          {
            outpoint: { transactionId: txid, index: 0 },
            amount: submitted.outputs[0].value,
            scriptPublicKey: submitted.outputs[0].scriptPublicKey,
            blockDaaScore: 9n,
            isCoinbase: false,
          },
          {
            outpoint: { transactionId: txid, index: 1 },
            amount: submitted.outputs[1].value,
            scriptPublicKey: submitted.outputs[1].scriptPublicKey,
            blockDaaScore: 9n,
            isCoinbase: false,
            covenantId,
          },
        ],
      };
    },
    getFeeEstimate: async () => {
      if (failPoint === "getFeeEstimate") {
        failPoint = undefined;
        throw new Error("injected pre-sign getFeeEstimate timeout");
      }
      return { estimate: { normalBuckets: [{ feerate: 100 }] } };
    },
    getServerInfo: async () => {
      if (failPoint === "getServerInfo") {
        failPoint = undefined;
        throw new Error("injected pre-sign getServerInfo timeout");
      }
      return { virtualDaaScore: "520936570" };
    },
    getMempoolEntry: async () => {
      throw new Error("transaction not found");
    },
    getVirtualChainFromBlock: async () => ({
      acceptedTransactionIds: submitted
        ? [{ acceptingBlockHash: "cc".repeat(32), acceptedTransactionIds: [String(submitted.finalize())] }]
        : [],
    }),
    submitTransaction: async ({ transaction }: { transaction: Transaction }) => {
      submitCalls += 1;
      submitted?.free();
      submitted = new Transaction(transaction);
      return { transactionId: String(submitted.finalize()) };
    },
  });
  const workingClient = (wallet as any).client;
  (wallet as any).client = async () => {
    if (failPoint === "wallet.client") {
      failPoint = undefined;
      throw new Error("injected pre-sign wallet.client timeout");
    }
    return workingClient();
  };

  try {
    const before = vault.config();
    assert.equal(vault.initialAddress(), created.address);
    for (const stage of [
      "wallet.client",
      "getUtxosByAddresses",
      "getFeeEstimate",
      "getServerInfo",
    ] as const) {
      failPoint = stage;
      await assert.rejects(
        vault.prepareSend(wallet, wallet.address, 70_000_000n),
        (error: unknown) =>
          error instanceof VaultPreparationError && error.code === "rpc_unavailable",
        `${stage} must be a typed pre-sign no-effect RPC failure`,
      );
    }
    vaultAmount = 73_569_300n;
    const lowBalancePrepared = await vault.prepareSend(wallet, wallet.address, 22_000_000n, undefined, 25_000_000n);
    assert.equal(lowBalancePrepared.amountSompi, 22_000_000n);
    assert.ok(lowBalancePrepared.feeSompi <= 25_000_000n);
    vaultAmount = 400_000_000n;
    await assert.rejects(
      vault.prepareSend(wallet, wallet.address, 70_000_000n, undefined, 1n),
      /fee exceeds the capacity reserved before signing/
    );
    const prepared = await vault.prepareSend(wallet, wallet.address, 70_000_000n);
    const agentPrivate = fs.readFileSync(path.join(directory, "vault", "agent-key"), "utf8").trim();
    assert.equal(vault.config().currentOutpoint?.txid, fundingTxid);
    assert.equal(prepared.destinationOutpoint.txid, prepared.transactionId);
    assert.equal(prepared.continuationOutpoint.txid, prepared.transactionId);
    assert.equal(prepared.amountSompi, 70_000_000n);
    assert.equal(prepared.transaction.includes(agentPrivate), false);
    assert.equal((await vault.submitPreparedSend(wallet, prepared)).transactionId, prepared.transactionId);
    const migrationId = "vmg_AAAAAAAAAAAAAAAAAAAAAA";
    const oldVaultDigest = vaultStaticConfigurationDigest(vault.config());
    vault.beginMigration(migrationId, oldVaultDigest);
    await assert.rejects(
      vault.submitPreparedSend(wallet, prepared),
      /vault protection update is in progress/,
    );
    assert.equal(submitCalls, 1, "a prepared spend must not cross an active migration fence");
    vault.finishMigration(migrationId, oldVaultDigest);
    assert.equal(vault.config().currentOutpoint?.txid, fundingTxid);
    const observed = {
      transactionId: prepared.transactionId,
      destinationOutpoint: prepared.destinationOutpoint,
      continuationOutpoint: prepared.continuationOutpoint,
      amountSompi: prepared.amountSompi,
      continuationAmountSompi: prepared.continuationAmountSompi,
      observedAtDaa: 9n,
      chainEvidenceDigest: `sha256:${"A".repeat(43)}`,
      chainEvidenceLevel: "accepted" as const,
    };
    assert.throws(
      () => vault.commitObservedSend(prepared, { ...observed, chainEvidenceLevel: "provisional" as never }),
      /observation does not match/
    );

    const committed = vault.commitObservedSend(prepared, observed);
    assert.equal(committed.currentOutpoint?.txid, prepared.transactionId);
    assert.equal(committed.currentOutpoint?.index, 1);
    assert.notEqual(committed.address, vault.initialAddress());
    assert.equal(vault.initialAddress(), created.address);
    assert.equal(vault.commitObservedSend(prepared, observed).address, committed.address);

    fs.writeFileSync(configPath, JSON.stringify(before, null, 2), { mode: 0o600 });
    const stale = { ...prepared, baseConfigDigest: "sha256:" + "A".repeat(43) };
    assert.throws(() => vault.commitObservedSend(stale, observed), /state advanced|metadata is invalid/);
  } finally {
    submitted?.free();
    vaultScript.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
