#!/usr/bin/env node
/**
 * Live proof of the stateful SompiVault on testnet-10.
 *
 * Exercises the current clean-cutover vault against a real node:
 *   1. first deposit creates a covenant-bound singleton vault UTXO
 *   2. agent withdrawal within the active rolling window is accepted on-chain
 *   3. a validly signed over-window withdrawal is rejected by consensus
 *   4. a finalized future-locktime reset attempt is rejected by the covenant
 *   5. top-up preserves the current state while adding funds to the singleton
 *   6. after the DAA window resets, another withdrawal is accepted
 *   7. owner recovery drains the remaining vault balance
 *
 * Usage: npm run build && SOMPI_NODE_URL=<node> npm run proof:vault
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CovenantBinding,
  Hash,
  PrivateKey,
  SighashType,
  Transaction,
  createInputSignature,
  payToAddressScript,
  payToScriptHashScript,
  payToScriptHashSignatureScript,
} = require("../vendor/kaspa-wasm/kaspa");
const { KaspaWallet } = require("../dist/wallet");
const { VaultManager, generateOwnerKey, spendVault } = require("../dist/vault");
const { buildRedeemScript, buildSigArgs, hexToBytes } = require("../dist/vault/template");

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const NODE = process.env.SOMPI_NODE_URL ?? "10.0.3.26";
const DATA_DIR = path.join(os.homedir(), ".sompi", NETWORK);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const VAULT_DATA_DIR = path.join(DATA_DIR, `vault-live-${RUN_ID}`);
const RECOVERY_PATH = path.join(DATA_DIR, `vault-live-recovery-${RUN_ID}.json`);
const SUBNETWORK_NATIVE = "00".repeat(20);
const VAULT_INPUT_COMPUTE_BUDGET = 50;
const NON_FINAL_SEQUENCE = 0n;
const FINAL_SEQUENCE = 0xffffffffffffffffn;

const DEPOSIT = BigInt(process.env.SOMPI_VAULT_LIVE_DEPOSIT ?? "300000000");
const TOPUP = BigInt(process.env.SOMPI_VAULT_LIVE_TOPUP ?? "50000000");
const MAX_OUTFLOW = BigInt(process.env.SOMPI_VAULT_LIVE_MAX_OUTFLOW ?? "100000000");
const WINDOW_DAA = BigInt(process.env.SOMPI_VAULT_LIVE_WINDOW_DAA ?? "300");
const WITHDRAW = BigInt(process.env.SOMPI_VAULT_LIVE_WITHDRAW ?? "40000000");
const RAW_FEE = BigInt(process.env.SOMPI_VAULT_LIVE_RAW_FEE ?? "2000000");
const WAIT_SECONDS = Number(process.env.SOMPI_VAULT_LIVE_WAIT_SECONDS ?? "240");

if (WINDOW_DAA < 10n) throw new Error("SOMPI_VAULT_LIVE_WINDOW_DAA must be at least 10 for the over-window probe");
if (!Number.isFinite(WAIT_SECONDS) || WAIT_SECONDS < 1) throw new Error("SOMPI_VAULT_LIVE_WAIT_SECONDS must be positive");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeRecovery(recovery) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(RECOVERY_PATH, `${JSON.stringify(recovery, null, 2)}\n`, { mode: 0o600 });
}

function readAgentPrivate() {
  return fs.readFileSync(path.join(VAULT_DATA_DIR, "vault", "agent-key"), "utf8").trim();
}

function normalizeEntries(entries) {
  return (entries ?? []).map((raw) => {
    const entry = raw?.entry ?? raw;
    const outpoint = raw?.outpoint ?? entry?.outpoint;
    const covenant = raw?.covenantId ?? entry?.covenantId;
    return {
      txid: String(outpoint?.transactionId),
      index: Number(outpoint?.index),
      amount: BigInt(raw?.amount ?? entry?.amount ?? 0),
      scriptPublicKey: raw?.scriptPublicKey ?? entry?.scriptPublicKey,
      blockDaaScore: BigInt(raw?.blockDaaScore ?? entry?.blockDaaScore ?? 0),
      isCoinbase: Boolean(raw?.isCoinbase ?? entry?.isCoinbase ?? false),
      covenantId: covenant ? String(covenant) : undefined,
    };
  });
}

async function currentVaultUtxo(wallet, config) {
  const rpc = await wallet.client();
  const { entries } = await rpc.getUtxosByAddresses([config.address]);
  const matches = normalizeEntries(entries).filter(
    (entry) =>
      entry.covenantId === config.covenantId &&
      (!config.currentOutpoint || (entry.txid === config.currentOutpoint.txid && entry.index === config.currentOutpoint.index))
  );
  if (matches.length !== 1) {
    throw new Error(`expected one current vault UTXO at ${config.address}, found ${matches.length}`);
  }
  return matches[0];
}

async function waitForVaultUtxo(wallet, vault, label) {
  let last = "not checked";
  for (let attempt = 0; attempt < WAIT_SECONDS; attempt++) {
    try {
      return await currentVaultUtxo(wallet, vault.config());
    } catch (error) {
      last = String(error.message ?? error);
    }
    await sleep(1_000);
  }
  throw new Error(`${label} vault UTXO was not indexed after ${WAIT_SECONDS}s (${last})`);
}

async function waitForDaa(wallet, target) {
  let last = 0n;
  for (let attempt = 0; attempt < WAIT_SECONDS; attempt++) {
    const info = await (await wallet.client()).getServerInfo();
    last = BigInt(info.virtualDaaScore);
    if (last >= target) return last;
    await sleep(1_000);
  }
  throw new Error(`DAA did not reach ${target} after ${WAIT_SECONDS}s (last ${last})`);
}

function txInput(utxo, signatureScript, sequence = NON_FINAL_SEQUENCE) {
  return {
    previousOutpoint: { transactionId: utxo.txid, index: utxo.index },
    signatureScript,
    sequence,
    sigOpCount: 0,
    computeBudget: VAULT_INPUT_COMPUTE_BUDGET,
    utxo: {
      outpoint: { transactionId: utxo.txid, index: utxo.index },
      amount: utxo.amount,
      scriptPublicKey: utxo.scriptPublicKey,
      blockDaaScore: utxo.blockDaaScore,
      isCoinbase: utxo.isCoinbase,
      covenantId: utxo.covenantId ? new Hash(utxo.covenantId) : undefined,
    },
  };
}

function buildTransaction({ inputs, outputs, lockTime }) {
  const tx = new Transaction({
    version: 1,
    inputs,
    outputs,
    lockTime,
    subnetworkId: SUBNETWORK_NATIVE,
    gas: 0n,
    payload: "",
  });
  const txInputs = tx.inputs;
  for (const input of txInputs) {
    input.sigOpCount = 0;
    input.computeBudget = VAULT_INPUT_COMPUTE_BUDGET;
  }
  tx.inputs = txInputs;
  tx.finalize();
  return tx;
}

function setInputScripts(tx, scripts) {
  const inputs = tx.inputs;
  for (let i = 0; i < scripts.length; i++) {
    inputs[i].signatureScript = scripts[i];
    inputs[i].sigOpCount = 0;
    inputs[i].computeBudget = VAULT_INPUT_COMPUTE_BUDGET;
  }
  tx.inputs = inputs;
  tx.finalize();
}

function covenantBinding(covenantId, authorizingInput) {
  return new CovenantBinding(authorizingInput, new Hash(covenantId));
}

async function rawOverWindowWithdraw(wallet, config, agentPrivate, destination, options = {}) {
  if (!config.covenantId) throw new Error("vault has no covenant id");
  const rpc = await wallet.client();
  const virtualDaa = BigInt((await rpc.getServerInfo()).virtualDaaScore);
  const now = virtualDaa > 0n ? virtualDaa - 1n : 0n;
  const windowStart = BigInt(config.windowStartDaa);
  const windowSize = BigInt(config.windowSizeDaa);
  const resetTarget = windowStart + windowSize;
  const lockTime = options.lockTime ?? now;
  const sequence = options.sequence ?? NON_FINAL_SEQUENCE;
  const resetWindow = Boolean(options.resetWindow);
  if (!resetWindow && now >= resetTarget) {
    throw new Error(`window already reset before over-window probe (locktime ${now}, reset ${windowStart + windowSize})`);
  }

  const max = BigInt(config.maxOutflowSompi);
  const spent = BigInt(config.spentInWindowSompi);
  const remaining = max - spent;
  if (remaining <= 0n) throw new Error("window already exhausted before over-window probe");

  const utxo = await currentVaultUtxo(wallet, config);
  let amount = remaining + 10_000_000n;
  if (resetWindow && amount + RAW_FEE > max) {
    amount = max - RAW_FEE;
  }
  if (amount <= remaining) {
    throw new Error(`raw probe cannot exceed remaining window ${remaining} while staying within reset cap ${max}`);
  }
  const outflow = amount + RAW_FEE;
  const change = utxo.amount - outflow;
  if (change <= 100_000_000n) {
    throw new Error(`vault UTXO ${utxo.amount} too small for raw over-window probe`);
  }

  const currentState = { windowStartDaa: windowStart, spentInWindowSompi: spent };
  const nextState = resetWindow
    ? { windowStartDaa: lockTime, spentInWindowSompi: outflow }
    : { windowStartDaa: windowStart, spentInWindowSompi: spent + outflow };
  const redeem = buildRedeemScript(config.agentPublic, config.ownerPublic, max, windowSize, currentState);
  const nextRedeem = buildRedeemScript(config.agentPublic, config.ownerPublic, max, windowSize, nextState);
  const vaultSpk = payToScriptHashScript(redeem);
  const nextSpk = payToScriptHashScript(nextRedeem);
  const destSpk = payToAddressScript(destination);
  const tx = buildTransaction({
    inputs: [txInput({ ...utxo, scriptPublicKey: vaultSpk }, "", sequence)],
    outputs: [
      { value: amount, scriptPublicKey: destSpk },
      { value: change, scriptPublicKey: nextSpk, covenant: covenantBinding(config.covenantId, 0) },
    ],
    lockTime,
  });
  const pushedSig = createInputSignature(tx, 0, new PrivateKey(agentPrivate), SighashType.All);
  setInputScripts(tx, [payToScriptHashSignatureScript(redeem, buildSigArgs(hexToBytes(pushedSig).slice(1), "withdraw"))]);
  const { transactionId } = await rpc.submitTransaction({ transaction: tx, allowOrphan: false });
  return String(transactionId);
}

async function main() {
  const wallet = new KaspaWallet({
    networkId: NETWORK,
    dataDir: DATA_DIR,
    nodeUrl: NODE,
  });
  const owner = generateOwnerKey();
  const vault = new VaultManager(VAULT_DATA_DIR, NETWORK);
  const recovery = {
    createdAt: new Date().toISOString(),
    network: NETWORK,
    node: NODE,
    vaultDataDir: VAULT_DATA_DIR,
    ownerPrivate: owner.privateKey,
    ownerPublic: owner.publicKey,
    note: "Temporary vault-live keys for recovering testnet funds if this harness exits early.",
    steps: [],
  };
  writeRecovery(recovery);

  let failures = 0;
  const check = (name, pass, detail = "") => {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
    if (!pass) failures++;
  };
  const record = (step, data) => {
    recovery.steps.push({ step, ...data });
    try {
      recovery.config = vault.config();
    } catch {
      /* vault may not exist yet */
    }
    writeRecovery(recovery);
  };

  try {
    const balance = await wallet.balanceSompi();
    const required = DEPOSIT + TOPUP + 100_000_000n;
    if (balance < required) {
      throw new Error(`wallet ${wallet.address} has ${balance} sompi; need at least ${required} for vault-live defaults`);
    }

    const created = vault.create(MAX_OUTFLOW, owner.publicKey, WINDOW_DAA);
    record("create", { config: created });
    console.log(`vault data dir: ${VAULT_DATA_DIR}`);
    console.log(`recovery file: ${RECOVERY_PATH}`);
    console.log(`agent wallet: ${wallet.address}`);

    const deposit = await vault.deposit(wallet, DEPOSIT);
    record("deposit", { txid: deposit.txid, depositedSompi: deposit.depositedSompi.toString(), feeSompi: deposit.feeSompi.toString() });
    await waitForVaultUtxo(wallet, vault, "initial deposit");
    check("genesis covenant-bound deposit accepted on-chain", true, deposit.txid.slice(0, 16));

    const first = await vault.send(wallet, wallet.address, WITHDRAW);
    record("withdraw-1", { txid: first.txid, amountSompi: first.amountSompi.toString(), feeSompi: first.feeSompi.toString() });
    await waitForVaultUtxo(wallet, vault, "first withdrawal");
    check("agent withdrawal inside rolling window accepted on-chain", true, first.txid.slice(0, 16));

    try {
      const txid = await rawOverWindowWithdraw(wallet, vault.config(), readAgentPrivate(), wallet.address);
      record("over-window-accepted", { txid });
      check("over-window withdrawal rejected by consensus", false, `accepted ${txid.slice(0, 16)}`);
    } catch (error) {
      const msg = String(error.message ?? error);
      check("over-window withdrawal rejected by consensus", /verif|script|reject|invalid|failed/i.test(msg), msg.slice(0, 120));
    }

    try {
      const current = vault.config();
      const futureLockTime = BigInt(current.windowStartDaa) + BigInt(current.windowSizeDaa);
      const txid = await rawOverWindowWithdraw(wallet, current, readAgentPrivate(), wallet.address, {
        lockTime: futureLockTime,
        sequence: FINAL_SEQUENCE,
        resetWindow: true,
      });
      record("finalized-future-locktime-accepted", { txid, futureLockTime: futureLockTime.toString() });
      check("finalized future-locktime reset rejected by covenant", false, `accepted ${txid.slice(0, 16)}`);
    } catch (error) {
      const msg = String(error.message ?? error);
      check("finalized future-locktime reset rejected by covenant", /verif|script|reject|invalid|failed/i.test(msg), msg.slice(0, 120));
    }

    const topup = await vault.deposit(wallet, TOPUP);
    record("topup", { txid: topup.txid, depositedSompi: topup.depositedSompi.toString(), feeSompi: topup.feeSompi.toString() });
    await waitForVaultUtxo(wallet, vault, "top-up");
    check("top-up through singleton covenant accepted on-chain", true, topup.txid.slice(0, 16));

    const resetTarget = BigInt(vault.config().windowStartDaa) + BigInt(vault.config().windowSizeDaa);
    const resetDaa = await waitForDaa(wallet, resetTarget + 1n);
    record("window-reset-reached", { resetDaa: resetDaa.toString(), resetTarget: resetTarget.toString() });
    const second = await vault.send(wallet, wallet.address, WITHDRAW);
    record("withdraw-2", { txid: second.txid, amountSompi: second.amountSompi.toString(), feeSompi: second.feeSompi.toString(), config: vault.config() });
    await waitForVaultUtxo(wallet, vault, "post-reset withdrawal");
    const postResetSpent = BigInt(vault.config().spentInWindowSompi);
    check(
      "withdrawal after DAA window reset accepted on-chain",
      postResetSpent < MAX_OUTFLOW && postResetSpent >= second.amountSompi + second.feeSompi,
      second.txid.slice(0, 16)
    );

    const recovered = await spendVault({
      wallet,
      config: vault.config(),
      fn: "recover",
      privateKey: owner.privateKey,
      destination: wallet.address,
    });
    record("recover", { txid: recovered.txid, amountSompi: recovered.amountSompi.toString(), feeSompi: recovered.feeSompi.toString() });
    check("owner recovery accepted on-chain", true, recovered.txid.slice(0, 16));
  } finally {
    await wallet.disconnect();
  }

  console.log(`recovery file: ${RECOVERY_PATH}`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("vault-live failed:", error.message ?? error);
  process.exit(1);
});
