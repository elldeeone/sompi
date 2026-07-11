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
import { calculateTransactionMass, payToAddressScript, payToScriptHashScript, Transaction } from "../vendor/kaspa-wasm/kaspa";
import { PolicyEngine, PolicyViolation } from "./policy";
import { VaultManager, generateOwnerKey as generateVaultOwnerKey } from "./vault";
import { buildRedeemScript, buildSigArgs, bytesToHex, hexToBytes } from "./vault/template";
import { buildEscrowRedeemScript, buildClaimArgs, buildRefundArgs, voucherMessage } from "./x402/escrow-template";
import { EscrowUtxoNotFoundError, escrowFunding, escrowScriptPubKeyHash, generateChannelKey, makeVoucher, verifyVoucher } from "./x402/escrow";
import { X402Client } from "./x402/client";
import { EscrowServer } from "./x402/escrow-server";
import { X_PAYMENT_HEADER, encodePaymentHeader } from "./x402/types";
import { KaspaWallet, formatKas } from "./wallet";
import {
  assertPurchaseId,
  assertPurchaseRequestKey,
  canonicalRequestUrl,
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "./purchase/identity";
import { PURCHASE_STATES } from "./purchase/types";
import { SUPPORTED_PROTOCOL_PROFILES } from "./protocols/profiles";

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const DATA_DIR = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK);

async function main() {
  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures++;
  };

  // --- offline checks: stable Purchase identity and protocol profile ---
  const fixedPurchaseId = createPurchaseId(new Uint8Array(16).fill(0x42));
  check(
    "purchase identity: fixed entropy produces stable opaque id",
    fixedPurchaseId === "pur_QkJCQkJCQkJCQkJCQkJCQg" && assertPurchaseId(fixedPurchaseId) === fixedPurchaseId
  );
  const requestKey = assertPurchaseRequestKey("agent-task:weather:0001");
  check("purchase identity: request key remains caller idempotency identity", requestKey === "agent-task:weather:0001");
  const baseRequest = {
    url: "https://merchant.example:443/data?city=Perth#not-sent",
    method: "post",
    body: new TextEncoder().encode('{"units":"metric"}'),
  };
  const fingerprint = requestFingerprint(baseRequest);
  check(
    "purchase identity: URL and method canonicalize without fragment",
    fingerprint === requestFingerprint({ ...baseRequest, url: "https://merchant.example/data?city=Perth", method: "POST" })
  );
  check(
    "purchase identity: method, URL, and body substitutions change fingerprint",
    fingerprint !== requestFingerprint({ ...baseRequest, method: "PUT" }) &&
      fingerprint !== requestFingerprint({ ...baseRequest, url: "https://merchant.example/data?city=Sydney" }) &&
      fingerprint !== requestFingerprint({ ...baseRequest, body: new TextEncoder().encode('{"units":"imperial"}') })
  );
  let credentialUrlDenied = false;
  try {
    canonicalRequestUrl("https://user:secret@merchant.example/data");
  } catch {
    credentialUrlDenied = true;
  }
  check("purchase identity: URL credentials rejected", credentialUrlDenied);
  const paymentOne = createPaymentIdentifier(fixedPurchaseId, 1);
  check(
    "purchase identity: payment identifiers are deterministic per attempt",
    paymentOne === createPaymentIdentifier(fixedPurchaseId, 1) && paymentOne !== createPaymentIdentifier(fixedPurchaseId, 2)
  );
  check(
    "purchase evidence: exact bytes determine digest",
    evidenceDigest("abc") === "sha256:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0" &&
      evidenceDigest("abc") !== evidenceDigest("abc\n")
  );
  check(
    "protocol profiles: AP2 and Kaspa-x402 pins fail closed to accepted release",
    SUPPORTED_PROTOCOL_PROFILES.ap2.gitCommit === "b4587ac1d055888a73b4b21750973cffba961793" &&
      SUPPORTED_PROTOCOL_PROFILES.ap2.checkoutMandateVct === "mandate.checkout.1" &&
      SUPPORTED_PROTOCOL_PROFILES.ap2.paymentMandateVct === "mandate.payment.1" &&
      SUPPORTED_PROTOCOL_PROFILES.ap2.nativeKasStrictlyStandardized === false &&
      SUPPORTED_PROTOCOL_PROFILES.x402.packages.client.version === "0.1.0-alpha.6" &&
      SUPPORTED_PROTOCOL_PROFILES.x402.allowMainnet === false &&
      PURCHASE_STATES.includes("failed_recoverable")
  );

  const walletVectorDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-wallet-vector-"));
  const walletVectorKey = "0000000000000000000000000000000000000000000000000000000000000001";
  const walletVectorPath = path.join(walletVectorDir, "wallet-key");
  fs.writeFileSync(walletVectorPath, walletVectorKey, { mode: 0o600 });
  const previousEnvKey = process.env.SOMPI_PRIVATE_KEY;
  const previousMainnet = process.env.SOMPI_ENABLE_MAINNET;
  delete process.env.SOMPI_PRIVATE_KEY;
  delete process.env.SOMPI_ENABLE_MAINNET;
  const walletVector = new KaspaWallet({ networkId: "testnet-10", dataDir: walletVectorDir });
  check(
    "wallet vector: fixed private key derives pinned testnet address with mode-0600 storage",
    walletVector.address === "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd" &&
      (fs.statSync(walletVectorPath).mode & 0o777) === 0o600
  );
  const walletVectorScript = payToAddressScript(walletVector.address);
  const walletVectorOutpoint = { transactionId: "11".repeat(32), index: 0 };
  const walletVectorTx = new Transaction({
    version: 0,
    inputs: [
      {
        previousOutpoint: walletVectorOutpoint,
        signatureScript: "",
        sequence: 0n,
        sigOpCount: 1,
        computeBudget: 0n,
        utxo: {
          outpoint: walletVectorOutpoint,
          amount: 100_000_000n,
          scriptPublicKey: walletVectorScript,
          blockDaaScore: 1n,
          isCoinbase: false,
        },
      },
    ],
    outputs: [{ value: 99_900_000n, scriptPublicKey: walletVectorScript }],
    lockTime: 0n,
    subnetworkId: "00".repeat(20),
    gas: 0n,
    payload: "",
  } as any);
  walletVectorTx.finalize();
  const walletVectorSignature = walletVector.signInput(walletVectorTx, 0);
  check(
    "wallet vector: pinned transaction identity signs with Schnorr plus All sighash",
    walletVectorTx.id === "f595f033a6b2ce46809bf63899a91ea083bb3043b7f68ac94899a6e21e1b7273" &&
      /^41[0-9a-f]{130}$/.test(walletVectorSignature) &&
      walletVectorSignature.endsWith("01")
  );
  let mainnetDenied = false;
  try {
    new KaspaWallet({ networkId: "mainnet", dataDir: walletVectorDir });
  } catch (error) {
    mainnetDenied = error instanceof Error && error.message.includes("Mainnet is disabled");
  }
  check("wallet vector: mainnet remains denied by default", mainnetDenied);
  if (previousEnvKey === undefined) delete process.env.SOMPI_PRIVATE_KEY;
  else process.env.SOMPI_PRIVATE_KEY = previousEnvKey;
  if (previousMainnet === undefined) delete process.env.SOMPI_ENABLE_MAINNET;
  else process.env.SOMPI_ENABLE_MAINNET = previousMainnet;
  fs.rmSync(walletVectorDir, { recursive: true, force: true });

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
    const redeem = bytesToHex(
      buildRedeemScript(f.agent, f.owner, BigInt(f.maxOutflow), BigInt(f.windowSize), {
        windowStartDaa: BigInt(f.windowStart),
        spentInWindowSompi: BigInt(f.spentInWindow),
      })
    );
    const withdrawArgs = bytesToHex(buildSigArgs(new Uint8Array(65).fill(0xab), "withdraw"));
    const topupArgs = bytesToHex(buildSigArgs(new Uint8Array(65).fill(0xab), "topup"));
    const recoverArgs = bytesToHex(buildSigArgs(new Uint8Array(65).fill(0xab), "recover"));
    if (
      redeem === f.redeemScript &&
      withdrawArgs === f.withdrawArgsWithDummySig &&
      topupArgs === f.topupArgsWithDummySig &&
      recoverArgs === f.recoverArgsWithDummySig
    ) {
      templateMatches++;
    } else {
      console.log(`  fixture mismatch: agent=${f.agent.slice(0, 8)} max=${f.maxOutflow}`);
    }
  }
  check(
    `vault template: byte-identical to compiler output (${templateMatches}/${fixtures.length} fixtures)`,
    templateMatches === fixtures.length
  );
  check(
    "vault template: withdraw/top-up reset paths read active input DAA score",
    fixtures.every((f: any) => (f.redeemScript.match(/b9c0/g) ?? []).length >= 2)
  );

  // --- offline checks: vault deposits aggregate fragmented wallet UTXOs ---
  const fragmentedVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-fragmented-"));
  const fragmentedWallet = new KaspaWallet({ networkId: "testnet-10", dataDir: path.join(fragmentedVaultDir, "wallet") });
  const owner = generateVaultOwnerKey();
  const vault = new VaultManager(fragmentedVaultDir, "testnet-10");
  vault.create(500_000_000n, owner.publicKey, 300n);
  const walletSpk = payToAddressScript(fragmentedWallet.address);
  const walletEntry = (tag: string, index: number, amount: bigint) => ({
    outpoint: { transactionId: tag.repeat(32), index },
    amount,
    scriptPublicKey: walletSpk,
    blockDaaScore: 1n,
    isCoinbase: false,
  });
  const directVaultAmount = 50_000_000n;
  let walletEntries = [walletEntry("11", 0, 90_000_000n), walletEntry("22", 0, 90_000_000n)];
  let submittedInputCounts: number[] = [];
  let submittedFinalFees: bigint[] = [];
  let submittedMinimumFees: bigint[] = [];
  let vaultUtxoAmount = 120_000_000n;
  let virtualDaaScore = 1n;
  let submitCount = 0;
  (fragmentedWallet as any).client = async () => ({
    getUtxosByAddresses: async (addresses: string[]) => {
      if (addresses[0] === fragmentedWallet.address) return { entries: walletEntries };
      const current = vault.config();
      if (addresses[0] !== current.address) return { entries: [] };
      const state = {
        windowStartDaa: BigInt(current.windowStartDaa),
        spentInWindowSompi: BigInt(current.spentInWindowSompi),
      };
      const directEntry = {
        outpoint: { transactionId: "bb".repeat(32), index: 0 },
        amount: directVaultAmount,
        scriptPublicKey: payToScriptHashScript(
          buildRedeemScript(current.agentPublic, current.ownerPublic, BigInt(current.maxOutflowSompi), BigInt(current.windowSizeDaa), state)
        ),
        blockDaaScore: 1n,
        isCoinbase: false,
      };
      if (!current.covenantId || !current.currentOutpoint) return { entries: [directEntry] };
      return {
        entries: [
          directEntry,
          {
            outpoint: { transactionId: current.currentOutpoint.txid, index: current.currentOutpoint.index },
            amount: vaultUtxoAmount,
            scriptPublicKey: payToScriptHashScript(
              buildRedeemScript(current.agentPublic, current.ownerPublic, BigInt(current.maxOutflowSompi), BigInt(current.windowSizeDaa), state)
            ),
            blockDaaScore: 1n,
            isCoinbase: false,
            covenantId: current.covenantId,
          },
        ],
      };
    },
    getFeeEstimate: async () => ({ estimate: { normalBuckets: [{ feerate: 100 }] } }),
    getServerInfo: async () => ({ virtualDaaScore: virtualDaaScore.toString() }),
    submitTransaction: async ({ transaction }: any) => {
      submittedInputCounts.push(transaction.inputs.length);
      const inputTotal = [...transaction.inputs].reduce((acc: bigint, input: any) => acc + BigInt(input.utxo.amount), 0n);
      const outputTotal = [...transaction.outputs].reduce((acc: bigint, output: any) => acc + BigInt(output.value), 0n);
      const finalFee = inputTotal - outputTotal;
      const computeBudgetMass = [...transaction.inputs].reduce((acc: bigint, input: any) => acc + BigInt(input.computeBudget ?? 0) * 100n, 0n);
      const minimumFee = (calculateTransactionMass("testnet-10", transaction) + computeBudgetMass) * 100n;
      if (finalFee < minimumFee) throw new Error(`underfunded vault tx: fee ${finalFee}, required ${minimumFee}`);
      submittedFinalFees.push(finalFee);
      submittedMinimumFees.push(minimumFee);
      submitCount += 1;
      const tag = ["33", "44", "77", "88", "99"][submitCount - 1] ?? "aa";
      return { transactionId: tag.repeat(32) };
    },
  });
  const preCovenantBalances = await vault.balanceBreakdown(fragmentedWallet);
  const fragmentedDeposit = await vault.deposit(fragmentedWallet, 120_000_000n);
  const postDepositBalances = await vault.balanceBreakdown(fragmentedWallet);
  walletEntries = [walletEntry("55", 0, 60_000_000n), walletEntry("66", 0, 60_000_000n)];
  const fragmentedTopup = await vault.deposit(fragmentedWallet, 80_000_000n);
  vaultUtxoAmount = 90_000_000n;
  const smallExplicitSpend = await vault.send(fragmentedWallet, fragmentedWallet.address, 10_000_000n);
  vaultUtxoAmount = 400_000_000n;
  const feeStressSpend = await vault.send(fragmentedWallet, fragmentedWallet.address, 200_000_000n);
  walletEntries = [walletEntry("99", 0, 500_000_000n), walletEntry("aa", 0, 500_000_000n)];
  const floatTarget = 25_000_000n;
  const maxFloatDeposit = await vault.deposit(fragmentedWallet, "max", floatTarget);
  const exhaustedConfig = {
    ...vault.config(),
    windowStartDaa: "1",
    spentInWindowSompi: "500000000",
    currentOutpoint: { txid: "cc".repeat(32), index: 0 },
  };
  fs.writeFileSync(path.join(fragmentedVaultDir, "vault", "config.json"), JSON.stringify(exhaustedConfig, null, 2));
  vaultUtxoAmount = 700_000_000n;
  walletEntries = [walletEntry("dd", 0, 200_000_000n)];
  virtualDaaScore = 350n;
  const resetTopup = await vault.deposit(fragmentedWallet, 50_000_000n);
  const resetTopupConfig = vault.config();
  check(
    "vault deposit: aggregates fragmented wallet UTXOs",
    fragmentedDeposit.txid === "33".repeat(32) && submittedInputCounts[0] === 2
  );
  check(
    "vault status: direct pre-covenant funds are unbound",
    preCovenantBalances.spendableSompi === 0n && preCovenantBalances.unboundSompi === directVaultAmount
  );
  check(
    "vault status: unbound funds stay separate after covenant deposit",
    postDepositBalances.spendableSompi === 120_000_000n && postDepositBalances.unboundSompi === directVaultAmount
  );
  check(
    "vault top-up: aggregates fragmented wallet UTXOs",
    fragmentedTopup.txid === "44".repeat(32) && submittedInputCounts[1] === 3
  );
  check(
    "vault explicit withdrawal: allows small vaults with positive change",
    smallExplicitSpend.txid === "77".repeat(32) && smallExplicitSpend.amountSompi === 10_000_000n && submittedInputCounts[2] === 1
  );
  check(
    "vault withdrawal: converges fee for small-change final mass",
    feeStressSpend.txid === "88".repeat(32) && submittedFinalFees[3] >= submittedMinimumFees[3]
  );
  check(
    "vault deposit: preserves requested wallet float after fee",
    maxFloatDeposit.txid === "99".repeat(32) &&
      1_000_000_000n - maxFloatDeposit.depositedSompi - maxFloatDeposit.feeSompi === floatTarget
  );
  check(
    "vault top-up: resets expired exhausted window",
    resetTopup.txid === "aa".repeat(32) &&
      resetTopupConfig.windowStartDaa === "349" &&
      resetTopupConfig.spentInWindowSompi === "0"
  );
  check(
    "vault deposit: fee covers final signed wallet mass",
    submittedFinalFees[0] >= submittedMinimumFees[0]
  );
  check(
    "vault top-up: fee covers final signed covenant mass",
    submittedFinalFees[1] >= submittedMinimumFees[1]
  );
  check(
    "vault withdrawal: fee covers final signed covenant mass",
    submittedFinalFees[2] >= submittedMinimumFees[2]
  );
  fs.rmSync(fragmentedVaultDir, { recursive: true, force: true });

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

  // --- offline checks: escrow client can fund new deposits from the vault treasury path ---
  const vaultFundedEscrowDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-vault-funded-"));
  const vaultFundingTxid = "44".repeat(32);
  let vaultFundingProviderCalls = 0;
  let hotWalletSends = 0;
  let fundedEscrowAddress = "";
  const vaultFundingPolicy = new PolicyEngine(vaultFundedEscrowDir);
  const vaultFundedClient = new X402Client(
    {
      networkId: "testnet-10",
      send: async () => {
        hotWalletSends++;
        throw new Error("hot wallet send should not fund escrow deposits when a vault funding source is configured");
      },
      client: async () => ({
        getUtxosByAddresses: async (addresses: string[]) => ({
          entries:
            addresses[0] === fundedEscrowAddress
              ? [{ outpoint: { transactionId: vaultFundingTxid, index: 0 }, amount: 1000n }]
              : [],
        }),
      }),
    } as any,
    vaultFundingPolicy,
    vaultFundedEscrowDir,
    {
      fundEscrowDeposit: async (request) => {
        vaultFundingProviderCalls++;
        fundedEscrowAddress = request.escrowAddress;
        return { txid: vaultFundingTxid, feeSompi: 123n, source: "vault" };
      },
    }
  );
  const vaultDeposit = await (vaultFundedClient as any).openEscrow("https://vault-funded.example", {
    network: "testnet-10",
    serverPublic: sampleServer.publicKey,
    refundTimeout: "123456",
    minDepositSompi: "1000",
    pricePerRequestSompi: "100",
  });
  const vaultFundedChannels = vaultFundedClient.escrowChannels().active;
  check(
    "x402 client: opens escrow deposits through vault funding source",
    vaultFundingProviderCalls === 1 &&
      hotWalletSends === 0 &&
      vaultDeposit.source === "vault" &&
      vaultDeposit.feeSompi === "123" &&
      vaultFundingPolicy.spentLastHour() === 1000n &&
      vaultFundedChannels.length === 1 &&
      vaultFundedChannels[0]?.fundingTxid === vaultFundingTxid &&
      vaultFundedChannels[0]?.fundingIndex === 0 &&
      vaultFundedChannels[0]?.fundingSource === "vault"
  );
  fs.rmSync(vaultFundedEscrowDir, { recursive: true, force: true });

  // --- offline checks: escrow rotation reports the fresh vault-funded deposit ---
  const rotationEscrowDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-rotation-"));
  const rotationFundingTxid = "88".repeat(32);
  let rotationFundedAddress = "";
  const rotatingEscrowState = {
    clientPrivate: sampleClient.privateKey,
    clientPublic: sampleClient.publicKey,
    serverPublic: sampleServer.publicKey,
    refundTimeout: "123456",
    escrowAddress: "kaspatest:qrotating",
    network: "testnet-10",
    depositedSompi: "1000",
    pricePerRequestSompi: "100",
    fundingSource: "vault",
    fundingTxid: "99".repeat(32),
    fundingIndex: 0,
    authorizedSompi: "900",
  };
  fs.writeFileSync(
    path.join(rotationEscrowDir, "client-escrows.json"),
    JSON.stringify({ active: { "https://rotate.example": rotatingEscrowState }, retired: [] })
  );
  const previousFetch = (globalThis as any).fetch;
  let rotationFetches = 0;
  (globalThis as any).fetch = async () => {
    rotationFetches++;
    return new Response("rotated-ok", { status: 200 });
  };
  try {
    const rotationClient = new X402Client(
      {
        networkId: "testnet-10",
        client: async () => ({
          getUtxosByAddresses: async (addresses: string[]) => ({
            entries:
              addresses[0] === rotationFundedAddress
                ? [{ outpoint: { transactionId: rotationFundingTxid, index: 0 }, amount: 1000n }]
                : [],
          }),
        }),
      } as any,
      new PolicyEngine(rotationEscrowDir),
      rotationEscrowDir,
      {
        requiredEscrowFundingSource: "vault",
        fundEscrowDeposit: async (request) => {
          rotationFundedAddress = request.escrowAddress;
          return { txid: rotationFundingTxid, source: "vault", feeSompi: 456n };
        },
      }
    );
    const rotationResult = await rotationClient.paidFetch("https://rotate.example/api");
    const rotationChannels = rotationClient.escrowChannels();
    check(
      "x402 client: reports deposit when rotating vault-funded escrows",
      rotationResult.status === 200 &&
        rotationResult.body === "rotated-ok" &&
        rotationResult.deposit?.txid === rotationFundingTxid &&
        rotationResult.deposit?.source === "vault" &&
        rotationResult.deposit?.feeSompi === "456" &&
        rotationResult.fundingSource === "vault" &&
        rotationResult.authorizedSompi === "100" &&
        rotationFetches === 1 &&
        rotationChannels.active.length === 1 &&
        rotationChannels.active[0]?.fundingTxid === rotationFundingTxid &&
        rotationChannels.retired.length === 1
    );
  } finally {
    (globalThis as any).fetch = previousFetch;
    fs.rmSync(rotationEscrowDir, { recursive: true, force: true });
  }

  // --- offline checks: vault-required mode fails before any wallet-funded fallback send ---
  const vaultRequiredEscrowDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-vault-required-"));
  let forbiddenWalletSends = 0;
  const vaultRequiredClient = new X402Client(
    {
      networkId: "testnet-10",
      send: async () => {
        forbiddenWalletSends++;
        return { txid: "77".repeat(32), feeSompi: 0n };
      },
    } as any,
    new PolicyEngine(vaultRequiredEscrowDir),
    vaultRequiredEscrowDir,
    { requiredEscrowFundingSource: "vault" }
  );
  let rejectedBeforeWalletSend = false;
  try {
    await (vaultRequiredClient as any).openEscrow("https://vault-required.example", {
      network: "testnet-10",
      serverPublic: sampleServer.publicKey,
      refundTimeout: "123456",
      minDepositSompi: "1000",
      pricePerRequestSompi: "100",
    });
  } catch (e) {
    rejectedBeforeWalletSend =
      String((e as Error).message ?? e).includes("no escrow funding provider") && forbiddenWalletSends === 0;
  }
  check("x402 client: vault-required mode rejects before wallet funding", rejectedBeforeWalletSend);
  fs.rmSync(vaultRequiredEscrowDir, { recursive: true, force: true });

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
    fundingSource: "vault",
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

  // --- offline checks: MCP-style x402 clients do not keep wallet-funded escrows active ---
  const escrowVaultOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-vault-only-"));
  const { fundingSource: _mainFundingSource, ...mainEscrowState } = {
    ...currentEscrowState,
    escrowAddress: "kaspatest:qmain",
    fundingTxid: "66".repeat(32),
  };
  const walletFundedEscrowState = {
    ...currentEscrowState,
    fundingSource: "wallet",
    fundingTxid: "55".repeat(32),
  };
  fs.writeFileSync(
    path.join(escrowVaultOnlyDir, "client-escrows.json"),
    JSON.stringify({
      active: {
        "https://vault.example": currentEscrowState,
        "https://wallet.example": walletFundedEscrowState,
        "https://main-shaped.example": mainEscrowState,
      },
      retired: [],
    })
  );
  const vaultOnlyClient = new X402Client(
    new KaspaWallet({ networkId: "testnet-10", dataDir: path.join(escrowVaultOnlyDir, "wallet") }),
    new PolicyEngine(escrowVaultOnlyDir),
    escrowVaultOnlyDir,
    { requiredEscrowFundingSource: "vault" }
  );
  const vaultOnlyStore = vaultOnlyClient.escrowChannels();
  const vaultOnlyPersisted = JSON.parse(fs.readFileSync(path.join(escrowVaultOnlyDir, "client-escrows.json"), "utf8"));
  check(
    "x402 client: vault mode preserves and retires wallet-funded escrow channels",
    vaultOnlyStore.active.length === 1 &&
      vaultOnlyStore.active[0]?.fundingSource === "vault" &&
      vaultOnlyStore.retired.length === 2 &&
      vaultOnlyStore.retired.every((channel) => channel.fundingSource === "wallet") &&
      vaultOnlyStore.retired.some((channel) => channel.clientPrivate === mainEscrowState.clientPrivate) &&
      Boolean(vaultOnlyPersisted.active["https://vault.example"]) &&
      !vaultOnlyPersisted.active["https://wallet.example"] &&
      !vaultOnlyPersisted.active["https://main-shaped.example"] &&
      vaultOnlyPersisted.retired.some((channel: any) => channel.fundingSource === "wallet" && channel.fundingTxid === mainEscrowState.fundingTxid)
  );
  fs.rmSync(escrowVaultOnlyDir, { recursive: true, force: true });

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
  new EscrowServer({
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
  const gateServer = new EscrowServer({
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
  const reloadServer = new EscrowServer({
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
  const cacheReplayServer = new EscrowServer({
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
  const pruneServer = new EscrowServer({
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
