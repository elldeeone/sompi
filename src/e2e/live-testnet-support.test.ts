import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  assertPrivateFile,
  initializeLiveProof,
} from "./live-testnet-support.js";

test("live proof initialization is owner-only, fresh, and restart-stable before any spend", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-proof-init-"));
  const source = path.join(root, "unopened-source-wallet");
  try {
    const first = initializeLiveProof(path.join(root, "proof"), source);
    const firstConfig = JSON.stringify(first.config);
    assert.equal(fs.statSync(first.layout.root).mode & 0o777, 0o700);
    for (const filename of [
      first.layout.configPath,
      first.layout.recoveryPath,
      path.join(first.config.wallets.treasuryDirectory, "wallet-key"),
      path.join(first.config.wallets.merchantDirectory, "wallet-key"),
      path.join(first.config.wallets.observerDirectory, "wallet-key"),
      first.config.vault.ownerKeyPath,
      first.config.borrow.ownerKeyPath,
    ]) {
      assertPrivateFile(filename);
    }
    assert.equal(
      new Set([
        first.config.wallets.treasuryAddress,
        first.config.wallets.merchantAddress,
        first.config.wallets.observerAddress,
      ]).size,
      3
    );
    const sensitiveBytes = [
      fs.readFileSync(path.join(first.config.wallets.treasuryDirectory, "wallet-key"), "utf8").trim(),
      fs.readFileSync(first.config.vault.ownerKeyPath, "utf8").trim(),
      fs.readFileSync(first.config.borrow.ownerKeyPath, "utf8").trim(),
    ];
    const recovery = fs.readFileSync(first.layout.recoveryPath, "utf8");
    for (const bytes of sensitiveBytes) assert.equal(recovery.includes(bytes), false);
    assert.equal(fs.existsSync(source), false, "initialization must not open the funding source");
    await Promise.all([
      first.treasuryWallet.disconnect(),
      first.merchantWallet.disconnect(),
      first.observerWallet.disconnect(),
    ]);

    const resumed = initializeLiveProof(path.join(root, "proof"), source);
    assert.equal(JSON.stringify(resumed.config), firstConfig);
    await Promise.all([
      resumed.treasuryWallet.disconnect(),
      resumed.merchantWallet.disconnect(),
      resumed.observerWallet.disconnect(),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
