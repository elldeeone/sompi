#!/usr/bin/env node
/**
 * Live proof for Phase 5 vault-backed agent commerce.
 *
 * The harness creates a disposable buyer wallet, creates/funds a covenant
 * vault, serves a local kaspa-escrow paid API, and proves paid_fetch opens the
 * escrow deposit from the vault treasury. Recovery data is written before
 * spending so interrupted runs remain recoverable on testnet.
 *
 * Usage:
 *   SOMPI_NODE_URL=<node> \
 *   SOMPI_PHASE5_LIVE_FUNDER_PRIVATE_KEY=<funded-testnet-key> \
 *   npm run proof:phase5
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { KaspaWallet } = require("../dist/wallet");
const { PolicyEngine } = require("../dist/policy");
const { VaultManager, generateOwnerKey, spendVault } = require("../dist/vault");
const { X402Client } = require("../dist/x402/client");
const { EscrowServer } = require("../dist/x402/escrow-server");
const { generateChannelKey, refundEscrow } = require("../dist/x402/escrow");

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const NODE = process.env.SOMPI_NODE_URL;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const DATA_ROOT = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK);
const DATA_DIR = process.env.SOMPI_PHASE5_LIVE_DIR ?? path.join(DATA_ROOT, `phase5-live-${RUN_ID}`);
const RECOVERY_PATH = path.join(DATA_ROOT, `phase5-live-recovery-${RUN_ID}.json`);
const PORT = Number(process.env.SOMPI_PHASE5_LIVE_PORT ?? "8767");

const BUYER_FUNDING = BigInt(process.env.SOMPI_PHASE5_LIVE_BUYER_FUNDING ?? "900000000");
const VAULT_DEPOSIT = BigInt(process.env.SOMPI_PHASE5_LIVE_VAULT_DEPOSIT ?? "600000000");
const VAULT_CAP = BigInt(process.env.SOMPI_PHASE5_LIVE_VAULT_CAP ?? "300000000");
const WINDOW_DAA = BigInt(process.env.SOMPI_PHASE5_LIVE_WINDOW_DAA ?? "300");
const MIN_ESCROW_DEPOSIT = BigInt(process.env.SOMPI_PHASE5_LIVE_MIN_ESCROW_DEPOSIT ?? "90000000");
const PRICE = BigInt(process.env.SOMPI_PHASE5_LIVE_PRICE ?? "30000000");
const REFUND_TIMEOUT_DELTA = BigInt(process.env.SOMPI_PHASE5_LIVE_REFUND_TIMEOUT_DELTA ?? "120");

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 180_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  const suffix = lastError ? `: ${lastError.message ?? lastError}` : "";
  throw new Error(`${label} timed out${suffix}`);
}

async function requireHealthyNode(wallet, label) {
  const info = await wallet.serverInfo();
  const problems = [];
  if (info.isSynced !== true) problems.push("not synced");
  if (info.hasUtxoIndex !== true) problems.push("utxoindex disabled");
  if (problems.length > 0) {
    throw new Error(
      `${label} node is not usable for the live proof: ${problems.join(", ")} ` +
        `(serverVersion=${info.serverVersion ?? "unknown"}, virtualDaaScore=${String(info.virtualDaaScore ?? "unknown")})`
    );
  }
  return info;
}

function withPrivateKey(privateKey, fn) {
  const previous = process.env.SOMPI_PRIVATE_KEY;
  if (privateKey) process.env.SOMPI_PRIVATE_KEY = privateKey;
  else delete process.env.SOMPI_PRIVATE_KEY;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.SOMPI_PRIVATE_KEY;
    else process.env.SOMPI_PRIVATE_KEY = previous;
  }
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : undefined;
}

function writeRecovery(state) {
  fs.mkdirSync(path.dirname(RECOVERY_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(RECOVERY_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const recovery = {
    runId: RUN_ID,
    network: NETWORK,
    node: NODE ?? "(resolver)",
    dataDir: DATA_DIR,
    recoveryPath: RECOVERY_PATH,
    txids: {},
  };

  const buyerWallet = withPrivateKey(undefined, () => new KaspaWallet({ networkId: NETWORK, dataDir: DATA_DIR, nodeUrl: NODE }));
  recovery.buyer = {
    address: buyerWallet.address,
    privateKey: readIfExists(path.join(DATA_DIR, "wallet-key")),
  };
  writeRecovery(recovery);

  const funderPrivate = process.env.SOMPI_PHASE5_LIVE_FUNDER_PRIVATE_KEY;
  const funderWallet = funderPrivate
    ? withPrivateKey(funderPrivate, () =>
        new KaspaWallet({ networkId: NETWORK, dataDir: path.join(DATA_ROOT, "phase5-live-funder"), nodeUrl: NODE })
      )
    : undefined;

  await requireHealthyNode(buyerWallet, "buyer");
  if (funderWallet) await requireHealthyNode(funderWallet, "funder");

  const policy = new PolicyEngine(DATA_DIR);
  const vault = new VaultManager(DATA_DIR, NETWORK);
  const configuredVault = vault.configured ? vault.config() : undefined;
  let existingVaultBalance = configuredVault?.covenantId ? await vault.balanceSompi(buyerWallet) : 0n;
  const buyerBalance = await buyerWallet.balanceSompi();
  if (existingVaultBalance < MIN_ESCROW_DEPOSIT && buyerBalance < BUYER_FUNDING) {
    if (!funderWallet) {
      throw new Error(
        `buyer wallet ${buyerWallet.address} has ${buyerBalance} sompi; set ` +
          `SOMPI_PHASE5_LIVE_FUNDER_PRIVATE_KEY to fund it with ${BUYER_FUNDING} sompi`
      );
    }
    const funding = await funderWallet.send(buyerWallet.address, BUYER_FUNDING);
    recovery.funder = { address: funderWallet.address };
    recovery.txids.buyerFunding = funding.txid;
    writeRecovery(recovery);
    await waitFor("buyer wallet funding", async () => (await buyerWallet.balanceSompi()) >= BUYER_FUNDING);
  }

  const owner = configuredVault
    ? {
        privateKey: process.env.SOMPI_PHASE5_LIVE_OWNER_PRIVATE_KEY,
        publicKey: configuredVault.ownerPublic,
      }
    : generateOwnerKey();
  if (!owner.privateKey) {
    throw new Error(
      `vault already exists in ${DATA_DIR}; set SOMPI_PHASE5_LIVE_OWNER_PRIVATE_KEY from the recovery file to resume`
    );
  }
  const serverKey = generateChannelKey();
  const info = await requireHealthyNode(buyerWallet, "buyer");
  const refundTimeout = BigInt(info.virtualDaaScore) + REFUND_TIMEOUT_DELTA;

  recovery.owner = owner;
  recovery.server = serverKey;
  recovery.refundTimeout = refundTimeout.toString();
  writeRecovery(recovery);

  const createdVault = configuredVault ?? vault.create(VAULT_CAP, owner.publicKey, WINDOW_DAA);
  recovery.vault = { ...createdVault, agentPrivate: readIfExists(path.join(DATA_DIR, "vault", "agent-key")) };
  writeRecovery(recovery);

  let deposit;
  if (existingVaultBalance >= MIN_ESCROW_DEPOSIT) {
    recovery.vaultBalanceSompi = existingVaultBalance.toString();
    writeRecovery(recovery);
  } else {
    deposit = await vault.deposit(buyerWallet, VAULT_DEPOSIT);
    recovery.txids.vaultDeposit = deposit.txid;
    recovery.vault = { ...vault.config(), agentPrivate: readIfExists(path.join(DATA_DIR, "vault", "agent-key")) };
    writeRecovery(recovery);
    await waitFor("vault genesis indexing", async () => (await vault.balanceSompi(buyerWallet)) >= MIN_ESCROW_DEPOSIT);
  }

  const sellerDir = path.join(DATA_DIR, "seller");
  const escrowServer = new EscrowServer({
    networkId: NETWORK,
    rpc: () => buyerWallet.client(),
    wallet: () => buyerWallet,
    serverPrivateHex: serverKey.privateKey,
    serverPublicHex: serverKey.publicKey,
    refundTimeout,
    minDepositSompi: MIN_ESCROW_DEPOSIT,
    pricePerRequestSompi: PRICE,
    dataDir: sellerDir,
    description: "phase5 live vault-backed paid_fetch proof",
  });

  let served = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/api/joke") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      if (await escrowServer.gate(req, res)) return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, joke: `phase5-${++served}` }));
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error.message ?? error));
    }
  });

  try {
    await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

    const x402 = new X402Client(buyerWallet, policy, DATA_DIR, {
      requiredEscrowFundingSource: "vault",
      fundEscrowDeposit: async ({ escrowAddress, amountSompi }) => {
        const result = await vault.send(buyerWallet, escrowAddress, amountSompi);
        recovery.txids.vaultEscrowDeposit = result.txid;
        recovery.vault = { ...vault.config(), agentPrivate: readIfExists(path.join(DATA_DIR, "vault", "agent-key")) };
        writeRecovery(recovery);
        return { txid: result.txid, feeSompi: result.feeSompi, source: "vault" };
      },
    });

    const first = await x402.paidFetch(`http://127.0.0.1:${PORT}/api/joke`);
    if (first.status !== 200) throw new Error(`first paid_fetch returned ${first.status}: ${first.body}`);
    if (first.deposit?.source !== "vault" || first.fundingSource !== "vault") {
      throw new Error(`first paid_fetch was not vault-backed: ${JSON.stringify(first)}`);
    }
    recovery.firstPaidFetch = first;
    recovery.escrows = x402.escrowChannels();
    writeRecovery(recovery);

    const second = await x402.paidFetch(`http://127.0.0.1:${PORT}/api/joke`);
    if (second.status !== 200) throw new Error(`second paid_fetch returned ${second.status}: ${second.body}`);
    if (second.fundingSource !== "vault") {
      throw new Error(`second paid_fetch did not reuse a vault-backed escrow: ${JSON.stringify(second)}`);
    }
    recovery.secondPaidFetch = second;
    recovery.escrows = x402.escrowChannels();
    writeRecovery(recovery);

    await waitFor("vault change indexing", async () => (await vault.balanceSompi(buyerWallet)) > 0n);
    const vaultRecovery = await spendVault({
      wallet: buyerWallet,
      config: vault.config(),
      fn: "recover",
      privateKey: owner.privateKey,
      destination: buyerWallet.address,
    });
    recovery.txids.vaultRecovery = vaultRecovery.txid;
    writeRecovery(recovery);

    const claims = await escrowServer.claimAll(buyerWallet.address);
    if (claims.length !== 1) throw new Error(`expected one escrow claim, got ${claims.length}`);
    recovery.claims = claims;
    recovery.txids.escrowClaim = claims[0].txid;
    writeRecovery(recovery);

    const channel = x402.escrowChannels().active[0];
    if (!channel) throw new Error("missing active escrow channel after paid_fetch");
    await waitFor("escrow refund timeout", async () => {
      const current = await (await buyerWallet.client()).getServerInfo();
      return BigInt(current.virtualDaaScore) >= refundTimeout;
    });
    const refund = await refundEscrow(
      buyerWallet,
      { clientPublic: channel.clientPublic, serverPublic: channel.serverPublic, timeout: BigInt(channel.refundTimeout) },
      channel.clientPrivate,
      buyerWallet.address
    );
    recovery.txids.escrowRefund = refund;
    writeRecovery(recovery);

    console.log(
      JSON.stringify(
        {
          dataDir: DATA_DIR,
          recoveryPath: RECOVERY_PATH,
          buyer: buyerWallet.address,
          vaultDepositTxid: deposit?.txid ?? recovery.txids.vaultDeposit,
          firstPaidFetch: first,
          secondPaidFetch: second,
          vaultRecoveryTxid: vaultRecovery.txid,
          escrowClaimTxid: claims[0].txid,
          escrowRefundTxid: refund,
          served,
        },
        null,
        2
      )
    );
  } finally {
    server.close();
    await buyerWallet.disconnect();
    if (funderWallet) await funderWallet.disconnect();
  }
}

main().catch((error) => {
  console.error("phase5-live failed:", error.message ?? error);
  console.error(`recovery file: ${RECOVERY_PATH}`);
  process.exit(1);
});
