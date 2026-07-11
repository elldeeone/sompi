import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { VaultManager, generateOwnerKey } from "./vault.js";
import { KaspaWallet } from "./wallet.js";

const FIXED_PRIVATE_KEY = "00".repeat(31) + "01";

test("wallet state is owner-only, no-clobber, and fails closed on link or mode attacks", () => {
  const root = temporaryDirectory("sompi-wallet-state-");
  const directory = path.join(root, "wallet");
  try {
    const wallet = new KaspaWallet({ networkId: "testnet-10", dataDir: directory });
    const keyPath = path.join(directory, "wallet-key");
    const original = fs.readFileSync(keyPath);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(keyPath).nlink, 1);
    assert.equal(
      new KaspaWallet({ networkId: "testnet-10", dataDir: directory }).address,
      wallet.address,
      "restart must load rather than replace the existing secret"
    );
    assert.deepEqual(fs.readFileSync(keyPath), original);

    const alias = path.join(root, "wallet-key-alias");
    fs.linkSync(keyPath, alias);
    assert.throws(
      () => new KaspaWallet({ networkId: "testnet-10", dataDir: directory }),
      /exactly one filesystem link/
    );
    fs.unlinkSync(alias);

    fs.chmodSync(keyPath, 0o640);
    assert.throws(
      () => new KaspaWallet({ networkId: "testnet-10", dataDir: directory }),
      /permissions must be 0600/
    );
    fs.chmodSync(keyPath, 0o600);

    const outside = path.join(root, "outside-wallet-key");
    fs.renameSync(keyPath, outside);
    fs.symlinkSync(outside, keyPath);
    assert.throws(
      () => new KaspaWallet({ networkId: "testnet-10", dataDir: directory }),
      /regular file/
    );
    fs.unlinkSync(keyPath);
    fs.renameSync(outside, keyPath);
    assert.deepEqual(fs.readFileSync(keyPath), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SOMPI_PRIVATE_KEY remains ephemeral and never creates or overwrites wallet state", () => {
  const root = temporaryDirectory("sompi-wallet-env-");
  const directory = path.join(root, "not-created");
  const previous = process.env.SOMPI_PRIVATE_KEY;
  try {
    process.env.SOMPI_PRIVATE_KEY = `  ${FIXED_PRIVATE_KEY}\n`;
    const first = new KaspaWallet({ networkId: "testnet-10", dataDir: directory });
    const second = new KaspaWallet({
      networkId: "testnet-10",
      dataDir: path.join(root, "also-not-created"),
    });
    assert.equal(first.address, second.address);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(fs.existsSync(path.join(root, "also-not-created")), false);
  } finally {
    if (previous === undefined) delete process.env.SOMPI_PRIVATE_KEY;
    else process.env.SOMPI_PRIVATE_KEY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("vault creation is durable, restartable, and never overwrites an interrupted secret", () => {
  const root = temporaryDirectory("sompi-vault-state-");
  try {
    const vault = new VaultManager(root, "testnet-10");
    const created = vault.create(500_000_000n, generateOwnerKey().publicKey, 300n);
    const vaultDirectory = path.join(root, "vault");
    const keyPath = path.join(vaultDirectory, "agent-key");
    const configPath = path.join(vaultDirectory, "config.json");
    assert.equal(fs.statSync(vaultDirectory).mode & 0o777, 0o700);
    for (const filename of [keyPath, configPath]) {
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
      assert.equal(fs.statSync(filename).nlink, 1);
    }
    assert.deepEqual(new VaultManager(root, "testnet-10").config(), created);

    const incompleteRoot = path.join(root, "incomplete");
    fs.mkdirSync(path.join(incompleteRoot, "vault"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(incompleteRoot, "vault", "agent-key"), FIXED_PRIVATE_KEY, {
      mode: 0o600,
    });
    const before = fs.readFileSync(path.join(incompleteRoot, "vault", "agent-key"));
    const interrupted = new VaultManager(incompleteRoot, "testnet-10");
    assert.throws(() => interrupted.configured, /incomplete after an interrupted creation/);
    assert.throws(
      () => interrupted.create(1n, generateOwnerKey().publicKey, 1n),
      /incomplete after an interrupted creation/
    );
    assert.deepEqual(fs.readFileSync(path.join(incompleteRoot, "vault", "agent-key")), before);
    assert.equal(fs.existsSync(path.join(incompleteRoot, "vault", "config.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("vault config rejects malformed, noncanonical, mismatched, and unsupported state", () => {
  const root = temporaryDirectory("sompi-vault-config-");
  try {
    const vault = new VaultManager(root, "testnet-10");
    vault.create(500_000_000n, generateOwnerKey().publicKey, 300n);
    const configPath = path.join(root, "vault", "config.json");
    const baseline = vault.config();
    const cases: Array<{ name: string; value: unknown; pattern: RegExp }> = [
      { name: "unknown field", value: { ...baseline, legacy: true }, pattern: /unsupported fields/ },
      { name: "missing template", value: omit(baseline, "template"), pattern: /missing or unsupported/ },
      { name: "wrong template", value: { ...baseline, template: "legacy" }, pattern: /unsupported vault template/ },
      { name: "leading-zero amount", value: { ...baseline, maxOutflowSompi: "01" }, pattern: /noncanonical/ },
      { name: "uint64 overflow", value: { ...baseline, windowStartDaa: (1n << 64n).toString() }, pattern: /exceeds uint64/ },
      { name: "overspent window", value: { ...baseline, spentInWindowSompi: "500000001" }, pattern: /exceeds its maximum/ },
      { name: "uppercase public key", value: { ...baseline, agentPublic: baseline.agentPublic.toUpperCase() }, pattern: /public keys/ },
      { name: "mismatched address", value: { ...baseline, address: `${baseline.address}x` }, pattern: /does not match/ },
      { name: "unpaired covenant", value: { ...baseline, covenantId: "aa".repeat(32) }, pattern: /must appear together/ },
      {
        name: "bad outpoint index",
        value: {
          ...baseline,
          covenantId: "aa".repeat(32),
          currentOutpoint: { txid: "bb".repeat(32), index: 2 },
        },
        pattern: /outpoint is invalid/,
      },
    ];
    for (const fixture of cases) {
      fs.writeFileSync(configPath, JSON.stringify(fixture.value), { mode: 0o600 });
      assert.throws(() => vault.config(), fixture.pattern, fixture.name);
    }

    fs.writeFileSync(configPath, "{", { mode: 0o600 });
    const keyBefore = fs.readFileSync(path.join(root, "vault", "agent-key"));
    assert.throws(() => vault.config(), /config is malformed/);
    assert.throws(
      () => vault.create(1n, generateOwnerKey().publicKey, 1n),
      /vault already exists/
    );
    assert.deepEqual(fs.readFileSync(path.join(root, "vault", "agent-key")), keyBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("vault rejects unsafe config/key paths and a substituted Agent key before RPC or signing", async () => {
  const root = temporaryDirectory("sompi-vault-adversarial-");
  try {
    const vault = new VaultManager(root, "testnet-10");
    const created = vault.create(500_000_000n, generateOwnerKey().publicKey, 300n);
    const vaultDirectory = path.join(root, "vault");
    const configPath = path.join(vaultDirectory, "config.json");
    const keyPath = path.join(vaultDirectory, "agent-key");

    fs.chmodSync(configPath, 0o644);
    assert.throws(() => vault.config(), /permissions must be 0600/);
    fs.chmodSync(configPath, 0o600);
    const configAlias = path.join(root, "config-alias");
    fs.linkSync(configPath, configAlias);
    assert.throws(() => vault.config(), /exactly one filesystem link/);
    fs.unlinkSync(configAlias);

    const keyAlias = path.join(root, "key-alias");
    fs.linkSync(keyPath, keyAlias);
    assert.throws(() => vault.configured, /exactly one filesystem link/);
    fs.unlinkSync(keyAlias);

    const outsideConfig = path.join(root, "outside-config");
    fs.renameSync(configPath, outsideConfig);
    fs.symlinkSync(outsideConfig, configPath);
    assert.throws(() => vault.config(), /regular file/);
    fs.unlinkSync(configPath);
    fs.renameSync(outsideConfig, configPath);

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...created,
        covenantId: "aa".repeat(32),
        currentOutpoint: { txid: "bb".repeat(32), index: 0 },
      }),
      { mode: 0o600 }
    );
    const substituted = generateOwnerKey().privateKey;
    fs.writeFileSync(keyPath, substituted, { mode: 0o600 });
    const wallet = new KaspaWallet({
      networkId: "testnet-10",
      dataDir: path.join(root, "wallet"),
    });
    await assert.rejects(
      vault.prepareSend(wallet, wallet.address, 1n),
      /Agent key does not match the configured public key/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}
