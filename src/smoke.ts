/**
 * End-to-end smoke test against a live network (default testnet-10).
 * Exercises: resolver connection, server info, address derivation,
 * balance, fee estimation, and local policy enforcement.
 *
 * Usage: npm run build && npm run smoke
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { payToScriptHashScript } from "../vendor/kaspa-wasm/kaspa";
import { PolicyEngine, PolicyViolation } from "./policy";
import { buildRedeemScript, buildSigArgs, bytesToHex, hexToBytes } from "./vault/template";
import { buildEscrowRedeemScript, buildClaimArgs, buildRefundArgs, voucherMessage } from "./x402/escrow-template";
import { EscrowUtxoNotFoundError, escrowFunding, escrowScriptPubKeyHash, generateChannelKey, makeVoucher, verifyVoucher } from "./x402/escrow";
import { X402Client } from "./x402/client";
import { EscrowTabServer } from "./x402/escrow-server";
import { X_PAYMENT_HEADER, encodePaymentHeader } from "./x402/types";
import { KaspaWallet, formatKas } from "./wallet";

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const DATA_DIR = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK);

async function main() {
  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures++;
  };

  // --- offline checks: policy engine ---
  const policy = new PolicyEngine(os.tmpdir());
  check("policy: defaults load", policy.policy.maxSompiPerTx === 100_000_000n);

  let denied = false;
  try {
    policy.authorize("kaspatest:qq000", 200_000_000n);
  } catch (e) {
    denied = e instanceof PolicyViolation;
  }
  check("policy: per-tx cap denies 2 KAS", denied);

  denied = false;
  try {
    policy.authorize("kaspatest:qq000", -5n);
  } catch (e) {
    denied = e instanceof PolicyViolation;
  }
  check("policy: negative amount denied", denied);

  policy.record(450_000_000n);
  denied = false;
  try {
    policy.authorize("kaspatest:qq000", 100_000_000n);
  } catch (e) {
    denied = e instanceof PolicyViolation;
  }
  check("policy: hourly cap denies after 4.5 KAS spent", denied);

  // --- offline checks: policy hot-reload ---
  const hotDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-smoke-"));
  const hotPolicyPath = path.join(hotDir, "policy.json");
  fs.writeFileSync(hotPolicyPath, JSON.stringify({ maxSompiPerTx: "100", maxSompiPerHour: "1000" }));
  const hotEngine = new PolicyEngine(hotDir, hotPolicyPath);
  let hotDenied = false;
  try {
    hotEngine.authorize("kaspatest:qq000", 200n);
  } catch {
    hotDenied = true;
  }
  // rewrite with a looser cap and a bumped mtime; no new engine instance
  fs.writeFileSync(hotPolicyPath, JSON.stringify({ maxSompiPerTx: "500", maxSompiPerHour: "1000" }));
  fs.utimesSync(hotPolicyPath, new Date(), new Date(Date.now() + 5));
  let hotAllowed = true;
  try {
    hotEngine.authorize("kaspatest:qq000", 200n);
  } catch {
    hotAllowed = false;
  }
  check("policy: hot-reload picks up file edits without restart", hotDenied && hotAllowed);

  fs.writeFileSync(hotPolicyPath, "{not json");
  fs.utimesSync(hotPolicyPath, new Date(), new Date(Date.now() + 10));
  let hotFailedClosed = false;
  try {
    hotEngine.authorize("kaspatest:qq000", 1n);
  } catch (e) {
    hotFailedClosed = e instanceof PolicyViolation && e.message.includes("malformed");
  }
  check("policy: malformed file fails closed", hotFailedClosed);
  fs.rmSync(hotDir, { recursive: true, force: true });

  // --- offline checks: vault template byte-equality vs compiler fixtures ---
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "scripts", "vault-fixtures.json"), "utf8"));
  let templateMatches = 0;
  for (const f of fixtures) {
    const redeem = bytesToHex(buildRedeemScript(f.agent, f.owner, BigInt(f.maxOutflow)));
    const withdrawArgs = bytesToHex(buildSigArgs(new Uint8Array(65).fill(0xab), "withdraw"));
    const recoverArgs = bytesToHex(buildSigArgs(new Uint8Array(65).fill(0xab), "recover"));
    if (redeem === f.redeemScript && withdrawArgs === f.withdrawArgsWithDummySig && recoverArgs === f.recoverArgsWithDummySig) {
      templateMatches++;
    } else {
      console.log(`  fixture mismatch: agent=${f.agent.slice(0, 8)} max=${f.maxOutflow}`);
    }
  }
  check(
    `vault template: byte-identical to compiler output (${templateMatches}/${fixtures.length} fixtures)`,
    templateMatches === fixtures.length
  );

  // --- offline checks: escrow template byte-equality vs SilverScript compiler fixtures ---
  // Regression guard only; scripts/escrow-live.js is the live consensus proof
  // for the current compiler-derived bytes.
  const escrowFixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "scripts", "escrow-fixtures.json"), "utf8"));
  let escrowMatches = 0;
  for (const f of escrowFixtures) {
    const redeem = bytesToHex(buildEscrowRedeemScript(f.client, f.server, BigInt(f.timeout), f.network ?? "testnet-10"));
    const claim = bytesToHex(
      buildClaimArgs(new Uint8Array(65).fill(0xab), new Uint8Array(64).fill(0xcd), new Uint8Array(8).fill(0xef))
    );
    const refund = bytesToHex(buildRefundArgs(new Uint8Array(65).fill(0xab)));
    if (redeem === f.redeemScript && claim === f.claimArgsWithDummies && refund === f.refundArgsWithDummySig) {
      escrowMatches++;
    } else {
      console.log(`  escrow fixture mismatch: client=${f.client.slice(0, 8)} timeout=${f.timeout}`);
    }
  }
  check(
    `escrow template: byte-identical to SilverScript compiler output (${escrowMatches}/${escrowFixtures.length})`,
    escrowMatches === escrowFixtures.length
  );
  const sampleClient = generateChannelKey();
  const sampleServer = generateChannelKey();
  const sampleParams = { clientPublic: sampleClient.publicKey, serverPublic: sampleServer.publicKey, timeout: 123n };
  const sampleOutpoint = { txid: "11".repeat(32), index: 0 };
  const siblingOutpoint = { txid: sampleOutpoint.txid, index: 1 };
  const sampleAmount = 42_000n;
  const sampleSpkHash = escrowScriptPubKeyHash(sampleParams, "testnet-10");
  const sampleSpk = payToScriptHashScript(
    buildEscrowRedeemScript(sampleParams.clientPublic, sampleParams.serverPublic, sampleParams.timeout, "testnet-10")
  );
  const sampleSpkScript = hexToBytes(String(sampleSpk.script));
  const sampleSpkVersion = Number(sampleSpk.version ?? 0);
  const serializedSampleSpk = new Uint8Array(2 + sampleSpkScript.length);
  serializedSampleSpk[0] = sampleSpkVersion & 0xff;
  serializedSampleSpk[1] = (sampleSpkVersion >>> 8) & 0xff;
  serializedSampleSpk.set(sampleSpkScript, 2);
  const samplePreimage = voucherMessage("testnet-10", sampleSpkHash, sampleOutpoint.txid, sampleOutpoint.index, sampleAmount);
  const sampleVoucher = makeVoucher(sampleClient.privateKey, sampleParams, "testnet-10", sampleOutpoint, sampleAmount);
  check("escrow voucher: fixed-width full-outpoint preimage", samplePreimage.length === 140);
  check("escrow voucher: hashes serialized scriptPublicKey", bytesToHex(sampleSpkHash) === bytesToHex(sha256(serializedSampleSpk)));
  check(
    "escrow voucher: same txid different vout rejected",
    verifyVoucher(sampleParams, "testnet-10", sampleOutpoint, sampleAmount, sampleVoucher.voucherHex) &&
      !verifyVoucher(sampleParams, "testnet-10", siblingOutpoint, sampleAmount, sampleVoucher.voucherHex)
  );
  const sampleRedeem = bytesToHex(buildEscrowRedeemScript(sampleParams.clientPublic, sampleParams.serverPublic, sampleParams.timeout, "testnet-10"));
  check("escrow template: contains CheckSigFromStack verify", sampleRedeem.includes("d769"));
  check("escrow template: hashes serialized active input scriptPubKey", sampleRedeem.includes("b9bfa87e"));
  check("escrow template: encodes vout as fixed le32", sampleRedeem.includes("b9bb54cd7e"));

  let missingOutpointIsTyped = false;
  try {
    await escrowFunding(
      {
        networkId: "testnet-10",
        client: async () => ({ getUtxosByAddresses: async () => ({ entries: [] }) }),
      } as any,
      sampleParams,
      sampleOutpoint
    );
  } catch (e) {
    missingOutpointIsTyped = e instanceof EscrowUtxoNotFoundError;
  }
  let lookupErrorPropagates = false;
  try {
    await escrowFunding(
      {
        networkId: "testnet-10",
        client: async () => ({
          getUtxosByAddresses: async () => {
            throw new Error("rpc unavailable");
          },
        }),
      } as any,
      sampleParams,
      sampleOutpoint
    );
  } catch (e) {
    lookupErrorPropagates = !(e instanceof EscrowUtxoNotFoundError) && String((e as Error).message ?? e).includes("rpc unavailable");
  }
  check("escrow funding: distinguishes missing outpoints from lookup errors", missingOutpointIsTyped && lookupErrorPropagates);

  // --- offline checks: escrow client persisted state is current-shape only ---
  const escrowStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-state-"));
  const currentEscrowState = {
    clientPrivate: sampleClient.privateKey,
    clientPublic: sampleClient.publicKey,
    serverPublic: sampleServer.publicKey,
    refundTimeout: "123",
    escrowAddress: "kaspatest:qcurrent",
    network: "testnet-10",
    depositedSompi: "1000",
    pricePerRequestSompi: "100",
    fundingTxid: "22".repeat(32),
    fundingIndex: 0,
    authorizedSompi: "0",
  };
  const { fundingTxid: _legacyFundingTxid, ...legacyEscrowState } = currentEscrowState;
  fs.writeFileSync(
    path.join(escrowStateDir, "client-escrows.json"),
    JSON.stringify({
      active: {
        "https://current.example": currentEscrowState,
        "https://stale.example": legacyEscrowState,
      },
      retired: [currentEscrowState, legacyEscrowState],
    })
  );
  const stateClient = new X402Client(
    new KaspaWallet({ networkId: "testnet-10", dataDir: path.join(escrowStateDir, "wallet") }),
    new PolicyEngine(escrowStateDir),
    escrowStateDir
  );
  const stateChannels = stateClient.escrowChannels();
  const sanitizedEscrows = JSON.parse(fs.readFileSync(path.join(escrowStateDir, "client-escrows.json"), "utf8"));
  check(
    "x402 client: drops non-current persisted escrow records",
    stateChannels.active.length === 1 &&
      stateChannels.retired.length === 1 &&
      Boolean(sanitizedEscrows.active["https://current.example"]) &&
      !sanitizedEscrows.active["https://stale.example"]
  );
  fs.rmSync(escrowStateDir, { recursive: true, force: true });

  // --- offline checks: escrow server persisted channels are current-shape only ---
  const escrowServerStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-server-state-"));
  const currentServerChannel = {
    clientPublic: sampleClient.publicKey,
    servedCount: 1,
    authorizedSompi: sampleAmount.toString(),
    voucherHex: sampleVoucher.voucherHex,
    outpointTxid: sampleOutpoint.txid,
    outpointIndex: sampleOutpoint.index,
  };
  const { outpointTxid: _legacyOutpointTxid, outpointIndex: _legacyOutpointIndex, ...legacyServerChannel } = currentServerChannel;
  fs.writeFileSync(
    path.join(escrowServerStateDir, "escrow-channels.json"),
    JSON.stringify([currentServerChannel, legacyServerChannel])
  );
  new EscrowTabServer({
    networkId: "testnet-10",
    rpc: async () => ({}) as any,
    wallet: () => ({}) as any,
    serverPrivateHex: sampleServer.privateKey,
    serverPublicHex: sampleServer.publicKey,
    refundTimeout: sampleParams.timeout,
    minDepositSompi: 1000n,
    pricePerRequestSompi: 100n,
    dataDir: escrowServerStateDir,
  });
  const sanitizedChannels = JSON.parse(fs.readFileSync(path.join(escrowServerStateDir, "escrow-channels.json"), "utf8"));
  check(
    "x402 server: drops non-current persisted escrow channels",
    sanitizedChannels.length === 1 && sanitizedChannels[0]?.clientPublic === sampleClient.publicKey
  );
  fs.rmSync(escrowServerStateDir, { recursive: true, force: true });

  // --- offline checks: rejected escrow headers do not force funding RPC lookups ---
  const escrowGateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-gate-"));
  let fundingLookups = 0;
  const gateServer = new EscrowTabServer({
    networkId: "testnet-10",
    rpc: async () => ({}) as any,
    wallet: () =>
      ({
        networkId: "testnet-10",
        client: async () => ({
          getUtxosByAddresses: async () => {
            fundingLookups++;
            return { entries: [] };
          },
        }),
      }) as any,
    serverPrivateHex: sampleServer.privateKey,
    serverPublicHex: sampleServer.publicKey,
    refundTimeout: sampleParams.timeout,
    minDepositSompi: 1000n,
    pricePerRequestSompi: 100n,
    dataDir: escrowGateDir,
  });
  const gateRes = () =>
    ({
      statusCode: 0,
      setHeader() {
        /* smoke response stub */
      },
      end() {
        /* smoke response stub */
      },
    }) as any;
  const underpaidHeader = encodePaymentHeader({
    scheme: "kaspa-escrow",
    clientPublic: sampleClient.publicKey,
    voucherAmountSompi: "1",
    voucherHex: sampleVoucher.voucherHex,
    outpointTxid: sampleOutpoint.txid,
    outpointIndex: sampleOutpoint.index,
  });
  const badSigHeader = encodePaymentHeader({
    scheme: "kaspa-escrow",
    clientPublic: sampleClient.publicKey,
    voucherAmountSompi: "100",
    voucherHex: "00".repeat(64),
    outpointTxid: sampleOutpoint.txid,
    outpointIndex: sampleOutpoint.index,
  });
  const underpaidRejected = await gateServer.gate({ headers: { [X_PAYMENT_HEADER]: underpaidHeader } } as any, gateRes());
  const badSigRejected = await gateServer.gate({ headers: { [X_PAYMENT_HEADER]: badSigHeader } } as any, gateRes());
  check(
    "x402 server: rejects bad vouchers before funding lookup",
    underpaidRejected && badSigRejected && fundingLookups === 0
  );
  fs.rmSync(escrowGateDir, { recursive: true, force: true });

  // --- offline checks: live server notices external channel-file rewrites ---
  const escrowReloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-reload-"));
  const escrowReloadPath = path.join(escrowReloadDir, "escrow-channels.json");
  fs.writeFileSync(escrowReloadPath, JSON.stringify([currentServerChannel]));
  const freshClient = generateChannelKey();
  const freshParams = { clientPublic: freshClient.publicKey, serverPublic: sampleServer.publicKey, timeout: sampleParams.timeout };
  const freshOutpoint = { txid: "33".repeat(32), index: 0 };
  const freshVoucher = makeVoucher(freshClient.privateKey, freshParams, "testnet-10", freshOutpoint, 100n);
  const reloadServer = new EscrowTabServer({
    networkId: "testnet-10",
    rpc: async () => ({}) as any,
    wallet: () =>
      ({
        networkId: "testnet-10",
        client: async () => ({
          getUtxosByAddresses: async () => ({
            entries: [{ outpoint: { transactionId: freshOutpoint.txid, index: freshOutpoint.index }, amount: 1000n }],
          }),
        }),
      }) as any,
    serverPrivateHex: sampleServer.privateKey,
    serverPublicHex: sampleServer.publicKey,
    refundTimeout: sampleParams.timeout,
    minDepositSompi: 1000n,
    pricePerRequestSompi: 100n,
    dataDir: escrowReloadDir,
  });
  fs.writeFileSync(escrowReloadPath, JSON.stringify([]));
  fs.utimesSync(escrowReloadPath, new Date(), new Date(Date.now() + 1000));
  const reloadAccepted = !(await reloadServer.gate(
    {
      headers: {
        [X_PAYMENT_HEADER]: encodePaymentHeader({
          scheme: "kaspa-escrow",
          clientPublic: freshClient.publicKey,
          voucherAmountSompi: freshVoucher.amountSompi,
          voucherHex: freshVoucher.voucherHex,
          outpointTxid: freshVoucher.outpointTxid,
          outpointIndex: freshVoucher.outpointIndex,
        }),
      },
    } as any,
    gateRes()
  ));
  const reloadedChannels = JSON.parse(fs.readFileSync(escrowReloadPath, "utf8"));
  check(
    "x402 server: reloads externally changed channel state before persisting",
    reloadAccepted && reloadedChannels.length === 1 && reloadedChannels[0]?.clientPublic === freshClient.publicKey
  );
  fs.rmSync(escrowReloadDir, { recursive: true, force: true });

  // --- offline checks: external reload invalidates stale positive UTXO cache ---
  const escrowCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-cache-"));
  const escrowCachePath = path.join(escrowCacheDir, "escrow-channels.json");
  fs.writeFileSync(escrowCachePath, JSON.stringify([currentServerChannel]));
  let cacheFunded = true;
  let cacheLookups = 0;
  const cacheReplayServer = new EscrowTabServer({
    networkId: "testnet-10",
    rpc: async () => ({}) as any,
    wallet: () =>
      ({
        networkId: "testnet-10",
        client: async () => ({
          getUtxosByAddresses: async () => {
            cacheLookups++;
            return cacheFunded
              ? { entries: [{ outpoint: { transactionId: sampleOutpoint.txid, index: sampleOutpoint.index }, amount: sampleAmount }] }
              : { entries: [] };
          },
        }),
      }) as any,
    serverPrivateHex: sampleServer.privateKey,
    serverPublicHex: sampleServer.publicKey,
    refundTimeout: sampleParams.timeout,
    minDepositSompi: 1000n,
    pricePerRequestSompi: 100n,
    dataDir: escrowCacheDir,
  });
  const replayHeader = encodePaymentHeader({
    scheme: "kaspa-escrow",
    clientPublic: sampleClient.publicKey,
    voucherAmountSompi: sampleVoucher.amountSompi,
    voucherHex: sampleVoucher.voucherHex,
    outpointTxid: sampleVoucher.outpointTxid,
    outpointIndex: sampleVoucher.outpointIndex,
  });
  const cacheSeedAccepted = !(await cacheReplayServer.gate(
    { headers: { [X_PAYMENT_HEADER]: replayHeader } } as any,
    gateRes()
  ));
  cacheFunded = false;
  fs.writeFileSync(escrowCachePath, JSON.stringify([]));
  fs.utimesSync(escrowCachePath, new Date(), new Date(Date.now() + 1000));
  const replayRejectedAfterReload = await cacheReplayServer.gate(
    { headers: { [X_PAYMENT_HEADER]: replayHeader } } as any,
    gateRes()
  );
  check(
    "x402 server: reload clears stale funding cache before voucher replay",
    cacheSeedAccepted && replayRejectedAfterReload && cacheLookups === 2
  );
  fs.rmSync(escrowCacheDir, { recursive: true, force: true });

  // --- offline checks: claim sweeps prune already-spent channel outpoints ---
  const escrowPruneDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-prune-"));
  const escrowPrunePath = path.join(escrowPruneDir, "escrow-channels.json");
  fs.writeFileSync(escrowPrunePath, JSON.stringify([currentServerChannel]));
  const pruneServer = new EscrowTabServer({
    networkId: "testnet-10",
    rpc: async () => ({}) as any,
    wallet: () =>
      ({
        networkId: "testnet-10",
        client: async () => ({ getUtxosByAddresses: async () => ({ entries: [] }) }),
      }) as any,
    serverPrivateHex: sampleServer.privateKey,
    serverPublicHex: sampleServer.publicKey,
    refundTimeout: sampleParams.timeout,
    minDepositSompi: 1000n,
    pricePerRequestSompi: 100n,
    dataDir: escrowPruneDir,
  });
  const pruneClaims = await pruneServer.claimAll("kaspatest:qnot-used");
  const prunedChannels = JSON.parse(fs.readFileSync(escrowPrunePath, "utf8"));
  check(
    "x402 server: claim sweep prunes stale spent channels",
    pruneClaims.length === 0 && Array.isArray(prunedChannels) && prunedChannels.length === 0
  );
  fs.rmSync(escrowPruneDir, { recursive: true, force: true });

  // --- online checks: live network ---
  if (process.env.SOMPI_SMOKE_OFFLINE) {
    console.log(`\nSOMPI_SMOKE_OFFLINE set; skipping live network checks.`);
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }
  console.log(`\nConnecting to ${NETWORK} via public resolver...`);
  const wallet = new KaspaWallet({ networkId: NETWORK, dataDir: DATA_DIR, nodeUrl: process.env.SOMPI_NODE_URL });
  check("wallet: address derived", wallet.address.length > 0, wallet.address);

  try {
    const info = await wallet.serverInfo();
    check("rpc: connected to node", true, `version ${info.serverVersion}, synced=${info.isSynced}`);
    check("rpc: node has utxoindex", info.hasUtxoIndex === true);
    check(
      "rpc: virtual DAA score sane",
      BigInt(info.virtualDaaScore) > 0n,
      `daa=${info.virtualDaaScore}`
    );

    const balance = await wallet.balanceSompi();
    check("rpc: balance query", balance >= 0n, `${formatKas(balance)} KAS`);

    const fees = await wallet.feeEstimate();
    const normal = (fees as any).estimate?.normalBuckets?.[0]?.feerate;
    check("rpc: fee estimate", normal !== undefined, `normal feerate=${normal} sompi/gram`);
  } catch (e) {
    check("rpc: live network checks", false, e instanceof Error ? e.message : String(e));
  } finally {
    await wallet.disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
