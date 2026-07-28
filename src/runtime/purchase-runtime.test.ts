import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  authorityRuntimePaths,
  initializeAuthorityRuntime,
} from "../authority/runtime.js";
import { SqliteAuthorityReplayStore } from "../authority/replay-store.js";
import {
  assertPurchaseRequestKey,
  createPurchaseId,
  requestFingerprint,
} from "../purchase/identity.js";
import { PurchaseJournal } from "../purchase/journal.js";
import { publishOperatorManifestForTests } from "../operator/manifest.js";
import { VaultManager, generateOwnerKey, vaultStaticConfigurationDigest } from "../vault.js";
import { KaspaWallet } from "../wallet.js";
import {
  purchaseRuntimeConfigFromEnv,
  type SompiPurchaseRuntimeConfig,
} from "./config.js";
import { createSompiPurchaseRuntime } from "./purchase-runtime.js";

const NOW = 1_800_000_000_000;

test("composition uses one dynamic clock and an immutable active policy snapshot", async () => {
  const fixture = await runtimeFixture();
  let now = NOW;
  const runtime = createSompiPurchaseRuntime(fixture.config, {
    now: () => now,
    resolver: publicResolver,
  });
  try {
    const resourceA = {
      url: "https://merchant.example/resource-a",
      method: "GET",
    };
    const first = runtime.journal.createPurchase({
      id: createPurchaseId(Buffer.alloc(16, 1)),
      requestKey: assertPurchaseRequestKey("runtime-clock:first"),
      resourceUrl: resourceA.url,
      method: resourceA.method,
      resourceFingerprint: requestFingerprint(resourceA),
    });
    assert.equal(first.createdAtMs, NOW);

    now += 12_345;
    const resourceB = {
      url: "https://merchant.example/resource-b",
      method: "POST",
      body: Buffer.from("request", "utf8"),
      mediaType: "application/octet-stream",
    };
    const second = runtime.journal.createPurchase({
      id: createPurchaseId(Buffer.alloc(16, 2)),
      requestKey: assertPurchaseRequestKey("runtime-clock:second"),
      resourceUrl: resourceB.url,
      method: resourceB.method,
      resourceFingerprint: requestFingerprint(resourceB),
    });
    assert.equal(second.createdAtMs, now);

    assert.equal(runtime.policy.policy.maxSompiPerTx, 100n);
    assert.throws(() => {
      (fixture.config.policy as { maxSompiPerTx: bigint }).maxSompiPerTx = 250n;
    }, TypeError);
    assert.equal(runtime.policy.policy.maxSompiPerTx, 100n);
    assert.equal(runtime.policy.policy.maxSompiPerHour, 500n);
  } finally {
    await runtime.close();
    fixture.dispose();
  }
});

test("invalid clocks and trust fail before wallet or journal creation", async () => {
  const invalidClock = await runtimeFixture();
  try {
    assert.throws(
      () =>
        createSompiPurchaseRuntime(invalidClock.config, {
          now: () => Number.NaN,
          resolver: publicResolver,
        }),
      /clock is unavailable/
    );
    assert.equal(fs.existsSync(path.join(invalidClock.config.dataDirectory, "wallet-key")), false);
    assert.equal(fs.existsSync(invalidClock.config.journalDatabase), false);
  } finally {
    invalidClock.dispose();
  }

  const invalidTrust = await runtimeFixture();
  try {
    fs.writeFileSync(invalidTrust.config.authority.paths.trust, "not-json\n", {
      mode: 0o600,
    });
    assert.throws(
      () =>
        createSompiPurchaseRuntime(invalidTrust.config, {
          now: () => NOW,
          resolver: publicResolver,
        }),
      /AP2|secure AP2/
    );
    assert.equal(fs.existsSync(path.join(invalidTrust.config.dataDirectory, "wallet-key")), false);
    assert.equal(fs.existsSync(invalidTrust.config.journalDatabase), false);
  } finally {
    invalidTrust.dispose();
  }
});

test("production composition rejects a signer socket owned by the MCP OS user", async () => {
  if (typeof process.getuid !== "function" || process.getuid() === 0) return;
  const fixture = await runtimeFixture();
  try {
    const unsafe = {
      ...fixture.config,
      authority: {
        ...fixture.config.authority,
        socketAccess: {
          expectedOwnerUserId: process.getuid(),
          groupId:
            typeof process.getgid === "function" ? process.getgid() : 1000,
        },
      },
    };
    assert.throws(
      () => createSompiPurchaseRuntime(unsafe, { resolver: publicResolver }),
      /OS user distinct/,
    );
    assert.equal(
      fs.existsSync(path.join(fixture.config.dataDirectory, "wallet-key")),
      false,
    );
  } finally {
    fixture.dispose();
  }
});

test("partial construction after both durable stores open closes both stores", async () => {
  const fixture = await runtimeFixture();
  const cleanup = instrumentRuntimeCleanup();
  try {
    fs.writeFileSync(fixture.config.stagingKeyDirectory, "not a directory\n", {
      mode: 0o600,
    });
    assert.throws(
      () =>
        createSompiPurchaseRuntime(fixture.config, {
          now: () => NOW,
          resolver: publicResolver,
        }),
      /staging key directory|secure staging key directory/
    );
    assert.equal(cleanup.calls.journal, 1);
    assert.equal(cleanup.calls.authorityReplay, 1);
    for (const database of [
      fixture.config.journalDatabase,
      fixture.config.authority.clientReplayDatabase,
    ]) {
      assert.equal(fs.existsSync(`${database}-wal`), false);
      assert.equal(fs.existsSync(`${database}-shm`), false);
    }
  } finally {
    cleanup.restore();
    fixture.dispose();
  }
});

test("runtime cleanup is memoized and attempts every resource after any cleanup failure", async () => {
  for (const failure of ["authorityReplay", "journal", "wallet"] as const) {
    const fixture = await runtimeFixture();
    const cleanup = instrumentRuntimeCleanup({ failure });
    try {
      const runtime = createSompiPurchaseRuntime(fixture.config, {
        now: () => NOW,
        resolver: publicResolver,
      });
      const closable: Readonly<{ close(): Promise<void> }> = runtime;
      const first = closable.close();
      const concurrent = closable.close();
      assert.equal(concurrent, first);
      await assert.rejects(first, /cleanup failed/);

      const repeated = closable.close();
      assert.equal(repeated, first);
      await assert.rejects(repeated, /cleanup failed/);
      assert.deepEqual(cleanup.calls, {
        journal: 1,
        authorityReplay: 1,
        wallet: 1,
      });
    } finally {
      cleanup.restore();
      fixture.dispose();
    }
  }
});

interface RuntimeFixture {
  readonly root: string;
  readonly config: SompiPurchaseRuntimeConfig;
  dispose(): void;
}

async function runtimeFixture(): Promise<RuntimeFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-purchase-runtime-"));
  const authorityDirectory = path.join(root, "authority");
  const authorityPaths = authorityRuntimePaths({ rootDirectory: authorityDirectory });
  await initializeAuthorityRuntime(authorityPaths, {
    issuer: "urn:sompi:authority:local",
    kid: "authority-signing-key-1",
  });
  const dataDirectory = path.join(root, "data");
  const vault = new VaultManager(dataDirectory, "testnet-10");
  const vaultConfig = vault.create(500_000_000n, generateOwnerKey().publicKey, 36_000n);
  const configDigest = vaultStaticConfigurationDigest(vaultConfig);
  const manifestPath = path.join(root, "operator", "manifest.json");
  publishOperatorManifestForTests(manifestPath, {
    schema: "sompi-operator-manifest-v2",
    revision: 1,
    networkId: "testnet-10",
    x402Network: "kaspa:testnet-10",
    dataDirectory,
    vault: {
      template: vaultConfig.template,
      ownerPublic: vaultConfig.ownerPublic,
      agentPublic: vaultConfig.agentPublic,
      address: vaultConfig.address,
      configDigest,
      maxOutflowSompi: vaultConfig.maxOutflowSompi,
      windowSizeDaa: vaultConfig.windowSizeDaa,
    },
    treasury: {
      maxSompiPerTx: "100",
      maxSompiPerHour: "500",
      allowlist: [],
      additionalCostCeilingAtomic: "25000000",
      operationFeeCeilingAtomic: "25000000",
    },
    merchant: {
      allowRules: [{ hostname: "merchant.example", ports: [443] }],
    },
    batch: { claimFeeReserveAtomic: "100000" },
    authority: { provider: "terminal", telegram: null },
    chainEvidence: {
      operatorNodeUrl: "ws://10.0.3.26:17210/",
      witnessBaseUrl: "https://api-tn10.kaspa.org/",
      depthConfirmationDaa: "10",
      finalityFloors: {
        settlement: "depth-confirmed",
        directTreasury: "accepted",
        vault: "accepted",
        staging: "accepted",
        recoveryRelease: "depth-confirmed",
      },
    },
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: 128,
      evidenceBytes: 67_108_864,
      directTreasuryRetries: 3,
    },
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const config = purchaseRuntimeConfigFromEnv(
    {
      SOMPI_OPERATOR_MANIFEST: manifestPath,
      SOMPI_OPERATOR_UID: String(uid),
      SOMPI_RUNTIME_GID: String(gid),
      SOMPI_AUTHORITY_ROOT_DIR: authorityDirectory,
      SOMPI_AUTHORITY_SOCKET_UID: String(
        Math.min((typeof process.getuid === "function" ? process.getuid() : 1000) + 1, 0x7fffffff)
      ),
      SOMPI_AUTHORITY_SOCKET_GID: String(
        typeof process.getgid === "function" ? process.getgid() : 1000
      ),
    },
    root,
    { allowSameUserOperatorManifestForTests: true }
  );
  return {
    root,
    config,
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function publicResolver(): Promise<readonly [{ address: string; family: 4 }]> {
  return [{ address: "8.8.8.8", family: 4 }] as const;
}

function instrumentRuntimeCleanup(
  options: Readonly<{
    failure?: "journal" | "authorityReplay" | "wallet";
  }> = {},
): Readonly<{
  calls: {
    journal: number;
    authorityReplay: number;
    wallet: number;
  };
  restore(): void;
}> {
  const calls = {
    journal: 0,
    authorityReplay: 0,
    wallet: 0,
  };
  const journalClose = PurchaseJournal.prototype.close;
  const authorityReplayClose = SqliteAuthorityReplayStore.prototype.close;
  const walletDisconnect = KaspaWallet.prototype.disconnect;

  PurchaseJournal.prototype.close = function instrumentedJournalClose(): void {
    calls.journal += 1;
    journalClose.call(this);
    if (options.failure === "journal") {
      throw new Error("injected Journal cleanup failure");
    }
  };
  SqliteAuthorityReplayStore.prototype.close =
    function instrumentedAuthorityReplayClose(): void {
      calls.authorityReplay += 1;
      authorityReplayClose.call(this);
      if (options.failure === "authorityReplay") {
        throw new Error("injected Authority replay-store cleanup failure");
      }
    };
  KaspaWallet.prototype.disconnect =
    async function instrumentedWalletDisconnect(): Promise<void> {
      calls.wallet += 1;
      await walletDisconnect.call(this);
      if (options.failure === "wallet") {
        throw new Error("injected wallet cleanup failure");
      }
    };

  let restored = false;
  return {
    calls,
    restore() {
      if (restored) return;
      restored = true;
      PurchaseJournal.prototype.close = journalClose;
      SqliteAuthorityReplayStore.prototype.close = authorityReplayClose;
      KaspaWallet.prototype.disconnect = walletDisconnect;
    },
  };
}
