import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  authorityRuntimePaths,
  initializeAuthorityRuntime,
} from "../authority/runtime.js";
import {
  assertPurchaseRequestKey,
  createPurchaseId,
  requestFingerprint,
} from "../purchase/identity.js";
import {
  purchaseRuntimeConfigFromEnv,
  type SompiPurchaseRuntimeConfig,
} from "./config.js";
import { createSompiPurchaseRuntime } from "./purchase-runtime.js";

const NOW = 1_800_000_000_000;

test("composition uses one dynamic clock for the journal and hot-reloads operator policy", async () => {
  const fixture = await runtimeFixture({ policy: true });
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
    assert.ok(fixture.policyPath);
    writePolicy(fixture.policyPath, "250", "1000");
    const changed = (fs.statSync(fixture.policyPath).mtimeMs + 10_000) / 1_000;
    fs.utimesSync(fixture.policyPath, changed, changed);
    assert.equal(runtime.policy.policy.maxSompiPerTx, 250n);
    assert.equal(runtime.policy.policy.maxSompiPerHour, 1000n);
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

test("partial construction closes the journal and a failed disconnect cannot skip durable-store close", async () => {
  const fixture = await runtimeFixture();
  try {
    fs.mkdirSync(fixture.config.authority.clientReplayDatabase, { mode: 0o700 });
    assert.throws(
      () =>
        createSompiPurchaseRuntime(fixture.config, {
          now: () => NOW,
          resolver: publicResolver,
        }),
      /replay|database path is unsafe/
    );
    assert.equal(fs.existsSync(`${fixture.config.journalDatabase}-wal`), false);
    assert.equal(fs.existsSync(`${fixture.config.journalDatabase}-shm`), false);

    fs.rmSync(fixture.config.authority.clientReplayDatabase, {
      recursive: true,
      force: true,
    });
    const runtime = createSompiPurchaseRuntime(fixture.config, {
      now: () => NOW,
      resolver: publicResolver,
    });
    let disconnects = 0;
    Object.defineProperty(runtime.wallet, "disconnect", {
      configurable: true,
      value: async () => {
        disconnects += 1;
        throw new Error("injected disconnect failure");
      },
    });
    await assert.rejects(runtime.close(), /cleanup failed/);
    assert.throws(() => runtime.journal.schemaVersion(), /not open/);
    await assert.rejects(runtime.close(), /cleanup failed/);
    assert.equal(disconnects, 1);
  } finally {
    fixture.dispose();
  }
});

interface RuntimeFixture {
  readonly root: string;
  readonly config: SompiPurchaseRuntimeConfig;
  readonly policyPath?: string;
  dispose(): void;
}

async function runtimeFixture(
  options: { readonly policy?: boolean } = {}
): Promise<RuntimeFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-purchase-runtime-"));
  const authorityDirectory = path.join(root, "authority");
  const authorityPaths = authorityRuntimePaths({ rootDirectory: authorityDirectory });
  await initializeAuthorityRuntime(authorityPaths, {
    issuer: "urn:sompi:authority:local",
    kid: "authority-signing-key-1",
  });
  const policyPath = options.policy ? path.join(root, "policy.json") : undefined;
  if (policyPath) writePolicy(policyPath, "100", "500");
  const config = purchaseRuntimeConfigFromEnv(
    {
      SOMPI_DATA_DIR: path.join(root, "data"),
      SOMPI_AUTHORITY_ROOT_DIR: authorityDirectory,
      SOMPI_AUTHORITY_SOCKET_UID: String(
        Math.min((typeof process.getuid === "function" ? process.getuid() : 1000) + 1, 0x7fffffff)
      ),
      SOMPI_AUTHORITY_SOCKET_GID: String(
        typeof process.getgid === "function" ? process.getgid() : 1000
      ),
      SOMPI_AP2_MERCHANT_RECEIPT_ISSUER: "receipt:merchant",
      SOMPI_AP2_PAYMENT_RECEIPT_ISSUER: "receipt:payment",
      SOMPI_EGRESS_ALLOW: JSON.stringify([
        { hostname: "merchant.example", ports: [443] },
      ]),
      ...(policyPath ? { SOMPI_POLICY: policyPath } : {}),
    },
    root
  );
  return {
    root,
    config,
    ...(policyPath ? { policyPath } : {}),
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writePolicy(filename: string, perPayment: string, perHour: string): void {
  fs.writeFileSync(
    filename,
    `${JSON.stringify({
      maxSompiPerTx: perPayment,
      maxSompiPerHour: perHour,
      allowlist: [],
      requireApprovalAboveSompi: "0",
    })}\n`,
    { mode: 0o600 }
  );
}

async function publicResolver(): Promise<readonly [{ address: string; family: 4 }]> {
  return [{ address: "8.8.8.8", family: 4 }] as const;
}
