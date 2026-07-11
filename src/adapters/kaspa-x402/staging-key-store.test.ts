import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { assertPurchaseId, createPaymentIdentifier } from "../../purchase/identity.js";
import {
  StagingKeyStore,
  StagingKeyStoreError,
  stagingKeyReference,
  type StagingKeyBinding,
} from "./staging-key-store.js";

const FIXED_PRIVATE_KEY = "01".padStart(64, "0");
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const PAYMENT_IDENTIFIER = createPaymentIdentifier(PURCHASE_ID, 1);
const BINDING: StagingKeyBinding = {
  purchaseId: PURCHASE_ID,
  paymentIdentifier: PAYMENT_IDENTIFIER,
};

test("staging key create is deterministic, idempotent, owner-only, and restart recoverable", async () => {
  const root = temporaryRoot();
  const directory = path.join(root, "keys");
  try {
    const store = fixedStore(directory);
    const created = store.create(BINDING);
    const repeated = store.create(BINDING);
    assert.deepEqual(repeated, created);
    assert.equal(created.keyReference, stagingKeyReference(BINDING));
    assert.equal(created.network, "kaspa:testnet-10");
    assert.equal(
      created.address,
      "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd"
    );
    assert.equal(
      created.publicKey,
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    );
    assert.equal(
      created.scriptPublicKey,
      "00002079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac"
    );
    assert.equal("privateKey" in created, false);

    const files = fs.readdirSync(directory);
    assert.deepEqual(files, [`${created.keyReference}.key`]);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, files[0])).mode & 0o777, 0o600);

    const restarted = fixedStore(directory);
    assert.deepEqual(restarted.recover({ ...BINDING, keyReference: created.keyReference }), created);
    const used = await restarted.withPrivateKey(
      { ...BINDING, keyReference: created.keyReference },
      (privateKey, record) => ({ privateKey: privateKey.toString(), record })
    );
    assert.equal(used.privateKey, FIXED_PRIVATE_KEY);
    assert.deepEqual(used.record, created);

    assert.equal(restarted.delete({ ...BINDING, keyReference: created.keyReference }), true);
    assert.equal(restarted.delete({ ...BINDING, keyReference: created.keyReference }), false);
    assert.equal(restarted.load({ ...BINDING, keyReference: created.keyReference }), undefined);
    assert.throws(
      () => restarted.recover({ ...BINDING, keyReference: created.keyReference }),
      /unavailable for recovery/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging key references bind exact Purchase and payment identities", () => {
  const otherPurchase = assertPurchaseId("pur_BBBBBBBBBBBBBBBBBBBBBB");
  const otherBinding = {
    purchaseId: otherPurchase,
    paymentIdentifier: createPaymentIdentifier(otherPurchase, 1),
  };
  assert.notEqual(stagingKeyReference(BINDING), stagingKeyReference(otherBinding));

  const root = temporaryRoot();
  try {
    const store = fixedStore(path.join(root, "keys"));
    const created = store.create(BINDING);
    assert.throws(
      () => store.load({ ...otherBinding, keyReference: created.keyReference }),
      /bound to different Purchase facts/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging key files fail closed on binding collision, content tampering, permissions, and hardlinks", () => {
  const root = temporaryRoot();
  const directory = path.join(root, "keys");
  try {
    const store = fixedStore(directory);
    const created = store.create(BINDING);
    const filename = path.join(directory, `${created.keyReference}.key`);
    const original = fs.readFileSync(filename, "utf8");
    const parsed = JSON.parse(original) as Record<string, unknown>;

    parsed.purchaseId = "pur_BBBBBBBBBBBBBBBBBBBBBB";
    fs.writeFileSync(filename, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    fs.chmodSync(filename, 0o600);
    assert.throws(
      () => store.recover({ ...BINDING, keyReference: created.keyReference }),
      /collides with different Purchase facts/
    );

    fs.writeFileSync(filename, original, { mode: 0o600 });
    fs.chmodSync(filename, 0o644);
    assert.throws(
      () => store.recover({ ...BINDING, keyReference: created.keyReference }),
      /permissions must be 0600/
    );

    fs.chmodSync(filename, 0o600);
    const hardlink = path.join(directory, "stolen.key");
    fs.linkSync(filename, hardlink);
    assert.throws(
      () => store.recover({ ...BINDING, keyReference: created.keyReference }),
      /exactly one filesystem link/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging key recovery repairs only its own interrupted publication hardlink", () => {
  const root = temporaryRoot();
  const directory = path.join(root, "keys");
  try {
    const store = fixedStore(directory);
    const created = store.create(BINDING);
    const filename = path.join(directory, `${created.keyReference}.key`);
    const interrupted = path.join(
      directory,
      `.${created.keyReference}.999.${"ab".repeat(16)}.tmp`
    );
    fs.linkSync(filename, interrupted);
    assert.equal(fs.statSync(filename).nlink, 2);

    assert.deepEqual(store.recover({ ...BINDING, keyReference: created.keyReference }), created);
    assert.equal(fs.existsSync(interrupted), false);
    assert.equal(fs.statSync(filename).nlink, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging key directory and generation configuration fail closed", () => {
  const root = temporaryRoot();
  try {
    const insecure = path.join(root, "insecure");
    fs.mkdirSync(insecure, { mode: 0o755 });
    fs.chmodSync(insecure, 0o755);
    assert.throws(
      () => fixedStore(insecure),
      /permissions must be 0700/
    );

    const invalid = new StagingKeyStore({
      directory: path.join(root, "invalid"),
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
      generatePrivateKey: () => "00".repeat(32),
    });
    assert.throws(() => invalid.create(BINDING), StagingKeyStoreError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixedStore(directory: string): StagingKeyStore {
  return new StagingKeyStore({
    directory,
    now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    generatePrivateKey: () => FIXED_PRIVATE_KEY,
  });
}

function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sompi-staging-key-"));
}
