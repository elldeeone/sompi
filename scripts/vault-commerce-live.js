#!/usr/bin/env node
/**
 * Live proof for vault-backed agent commerce.
 *
 * The harness creates a disposable buyer wallet, creates/funds a covenant
 * vault, serves a local kaspa-escrow paid API, and proves paid_fetch opens the
 * escrow deposit from the vault treasury. Recovery data is written before
 * spending so interrupted runs remain recoverable on testnet.
 *
 * Usage:
 *   SOMPI_NODE_URL=<node> \
 *   SOMPI_VAULT_COMMERCE_FUNDER_PRIVATE_KEY=<funded-testnet-key> \
 *   npm run proof:vault-commerce
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
const { EscrowUtxoNotFoundError, escrowFunding, generateChannelKey, refundEscrow } = require("../dist/x402/escrow");

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const NODE = process.env.SOMPI_NODE_URL;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const DATA_ROOT = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK);
const DATA_DIR = process.env.SOMPI_VAULT_COMMERCE_DIR ?? path.join(DATA_ROOT, `vault-commerce-live-${RUN_ID}`);
const RECOVERY_PATH = path.join(DATA_ROOT, `vault-commerce-recovery-${RUN_ID}.json`);
const PORT = Number(process.env.SOMPI_VAULT_COMMERCE_PORT ?? "8767");

const BUYER_FUNDING = BigInt(process.env.SOMPI_VAULT_COMMERCE_BUYER_FUNDING ?? "900000000");
const VAULT_DEPOSIT = BigInt(process.env.SOMPI_VAULT_COMMERCE_VAULT_DEPOSIT ?? "600000000");
const VAULT_CAP = BigInt(process.env.SOMPI_VAULT_COMMERCE_VAULT_CAP ?? "300000000");
const WINDOW_DAA = BigInt(process.env.SOMPI_VAULT_COMMERCE_WINDOW_DAA ?? "300");
const MIN_ESCROW_DEPOSIT = BigInt(process.env.SOMPI_VAULT_COMMERCE_MIN_ESCROW_DEPOSIT ?? "90000000");
const PRICE = BigInt(process.env.SOMPI_VAULT_COMMERCE_PRICE ?? "30000000");
const REFUND_TIMEOUT_DELTA = BigInt(process.env.SOMPI_VAULT_COMMERCE_REFUND_TIMEOUT_DELTA ?? "120");

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

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadRecoveryHistoryForDataDir() {
  if (!fs.existsSync(DATA_ROOT)) return [];
  return fs
    .readdirSync(DATA_ROOT)
    .filter((name) => /^vault-commerce-recovery-.*\.json$/.test(name))
    .map((name) => path.join(DATA_ROOT, name))
    .map((file) => {
      try {
        return { file, mtimeMs: fs.statSync(file).mtimeMs, recovery: readJsonIfExists(file) };
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry?.recovery?.dataDir === DATA_DIR)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function mergeRecoveryHistory(history) {
  const merged = {};
  for (const { recovery } of history) {
    Object.assign(merged, recovery);
    merged.txids = { ...(merged.txids ?? {}), ...(recovery.txids ?? {}) };
  }
  return merged;
}

function persistedClientEscrowState() {
  const raw = readJsonIfExists(path.join(DATA_DIR, "client-escrows.json"));
  const active = isRecord(raw?.active) ? Object.values(raw.active).filter(isRecord) : [];
  const serverPublics = uniqueStrings(active.map((channel) => channel.serverPublic));
  const refundTimeouts = uniqueStrings(active.map((channel) => channel.refundTimeout));
  if (serverPublics.length > 1 || refundTimeouts.length > 1) {
    throw new Error("vault-commerce proof resume supports one active paid_fetch escrow origin; use a fresh SOMPI_VAULT_COMMERCE_DIR");
  }
  return {
    serverPublic: serverPublics[0],
    refundTimeout: refundTimeouts[0],
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function isChannelKey(value) {
  return isRecord(value) && /^[0-9a-f]{64}$/i.test(value.privateKey ?? "") && /^[0-9a-f]{64}$/i.test(value.publicKey ?? "");
}

function savedServerKey(history, mergedRecovery, requiredPublic) {
  if (requiredPublic) {
    const matched = [...history].reverse().find((entry) => isChannelKey(entry.recovery?.server) && entry.recovery.server.publicKey === requiredPublic);
    if (!matched) {
      throw new Error(
        `existing client escrow state is bound to server ${requiredPublic}, but no matching vault-commerce recovery file was found`
      );
    }
    return matched.recovery.server;
  }
  return isChannelKey(mergedRecovery.server) ? mergedRecovery.server : undefined;
}

function writeRecovery(state) {
  fs.mkdirSync(path.dirname(RECOVERY_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(RECOVERY_PATH, JSON.stringify(state, bigintSafe, 2), { mode: 0o600 });
}

async function waitForEscrowClaimChange(wallet, params, originalOutpoint, claimTxid) {
  return waitFor("escrow claim change indexing", async () => {
    const change = await escrowFunding(wallet, params, { txid: claimTxid, index: 1 });
    try {
      await escrowFunding(wallet, params, originalOutpoint);
      return undefined;
    } catch (error) {
      if (error instanceof EscrowUtxoNotFoundError || error?.name === "EscrowUtxoNotFoundError") {
        return change;
      }
      throw error;
    }
  });
}

function bigintSafe(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const recoveryHistory = loadRecoveryHistoryForDataDir();
  const previousRecovery = mergeRecoveryHistory(recoveryHistory);
  const recovery = {
    ...previousRecovery,
    runId: RUN_ID,
    network: NETWORK,
    node: NODE ?? "(resolver)",
    dataDir: DATA_DIR,
    recoveryPath: RECOVERY_PATH,
    txids: { ...(previousRecovery.txids ?? {}) },
  };

  const buyerWallet = withPrivateKey(undefined, () => new KaspaWallet({ networkId: NETWORK, dataDir: DATA_DIR, nodeUrl: NODE }));
  recovery.buyer = {
    address: buyerWallet.address,
    privateKey: readIfExists(path.join(DATA_DIR, "wallet-key")),
  };
  writeRecovery(recovery);

  const funderPrivate = process.env.SOMPI_VAULT_COMMERCE_FUNDER_PRIVATE_KEY;
  const funderWallet = funderPrivate
    ? withPrivateKey(funderPrivate, () =>
        new KaspaWallet({ networkId: NETWORK, dataDir: path.join(DATA_ROOT, "vault-commerce-funder"), nodeUrl: NODE })
      )
    : undefined;

  await requireHealthyNode(buyerWallet, "buyer");
  if (funderWallet) await requireHealthyNode(funderWallet, "funder");

  const policy = new PolicyEngine(DATA_DIR);
  const vault = new VaultManager(DATA_DIR, NETWORK);
  const configuredVault = vault.configured ? vault.config() : undefined;
  const persistedEscrow = persistedClientEscrowState();
  let existingVaultBalance = configuredVault?.covenantId ? await vault.balanceSompi(buyerWallet) : 0n;
  const buyerBalance = await buyerWallet.balanceSompi();
  if (existingVaultBalance < MIN_ESCROW_DEPOSIT && buyerBalance < BUYER_FUNDING) {
    if (!funderWallet) {
      throw new Error(
        `buyer wallet ${buyerWallet.address} has ${buyerBalance} sompi; set ` +
          `SOMPI_VAULT_COMMERCE_FUNDER_PRIVATE_KEY to fund it with ${BUYER_FUNDING} sompi`
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
        privateKey: process.env.SOMPI_VAULT_COMMERCE_OWNER_PRIVATE_KEY ?? previousRecovery.owner?.privateKey,
        publicKey: configuredVault.ownerPublic,
      }
    : generateOwnerKey();
  if (!owner.privateKey) {
    throw new Error(
      `vault already exists in ${DATA_DIR}; set SOMPI_VAULT_COMMERCE_OWNER_PRIVATE_KEY from the recovery file to resume`
    );
  }
  const serverKey = savedServerKey(recoveryHistory, previousRecovery, persistedEscrow.serverPublic) ?? generateChannelKey();
  const info = await requireHealthyNode(buyerWallet, "buyer");
  const refundTimeout = BigInt(persistedEscrow.refundTimeout ?? previousRecovery.refundTimeout ?? BigInt(info.virtualDaaScore) + REFUND_TIMEOUT_DELTA);

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
    description: "vault-backed commerce live proof",
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
      res.end(JSON.stringify({ ok: true, joke: `vault-commerce-${++served}` }));
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

    const channel = x402.escrowChannels().active[0];
    if (!channel) throw new Error("missing active escrow channel after paid_fetch");
    if (channel.fundingIndex === undefined) throw new Error("active escrow channel has no funding index");
    const channelParams = {
      clientPublic: channel.clientPublic,
      serverPublic: channel.serverPublic,
      timeout: BigInt(channel.refundTimeout),
    };
    const originalEscrowOutpoint = { txid: channel.fundingTxid, index: channel.fundingIndex };

    const claims = await escrowServer.claimAll(buyerWallet.address);
    const claim = claims.find((entry) => entry.clientPublic === channel.clientPublic);
    if (!claim) throw new Error(`expected one escrow claim for ${channel.clientPublic}, got ${claims.length}`);
    recovery.claims = claims;
    recovery.txids.escrowClaim = claim.txid;
    writeRecovery(recovery);

    const claimChange = await waitForEscrowClaimChange(buyerWallet, channelParams, originalEscrowOutpoint, claim.txid);
    recovery.escrowClaimChange = claimChange;
    writeRecovery(recovery);

    await waitFor("escrow refund timeout", async () => {
      const current = await (await buyerWallet.client()).getServerInfo();
      return BigInt(current.virtualDaaScore) >= channelParams.timeout;
    });
    const refund = await refundEscrow(
      buyerWallet,
      channelParams,
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
          escrowClaimTxid: claim.txid,
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
  console.error("vault-commerce-live failed:", error.message ?? error);
  console.error(`recovery file: ${RECOVERY_PATH}`);
  process.exit(1);
});
