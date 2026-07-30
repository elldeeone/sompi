import * as assert from "node:assert/strict";
import test from "node:test";

import { JournalNotFoundError } from "../journal/contracts.js";
import { activateBootstrapVault, driveBootstrapVaultDeposit, finalizeVaultActivationResult } from "./vault-activation.js";

const TXID = "a".repeat(64);
const DIGEST = `sha256:${"A".repeat(43)}`;

test("vault activation worker rejects root before opening runtime state", async () => {
  await assert.rejects(
    () => activateBootstrapVault({ SOMPI_API_UID: "0" }),
    /isolated API principal/,
  );
});

test("vault activation result requires a completed minimum deposit", () => {
  const completed = {
    operationKey: "bootstrap:test",
    kind: "vault_deposit" as const,
    state: "completed" as const,
    summary: "done",
    destination: "kaspatest:test",
    requestedAmountAtomic: "max" as const,
    keepFloatAtomic: "10000000",
    feeCeilingAtomic: "25000000",
    amountAtomic: "50000000",
    feeAtomic: "1000000",
    transactionId: TXID,
    retryCount: 0,
    recoveryRequired: false,
    safeToRetry: false,
    cancellationRequested: false,
    preparationFenced: false,
  };
  assert.deepEqual(
    finalizeVaultActivationResult(DIGEST, "kaspatest:funding", 86_000_000n, "kaspatest:vault", completed, 50_000_000n),
    {
      status: "ready",
      requestDigest: DIGEST,
      fundingAddress: "kaspatest:funding",
      fundingBalanceObservedSompi: "86000000",
      vaultAddress: "kaspatest:vault",
      vaultDepositSompi: "50000000",
      feeSompi: "1000000",
      transactionId: TXID,
    },
  );
  assert.throws(
    () => finalizeVaultActivationResult(DIGEST, "kaspatest:funding", 86_000_000n, "kaspatest:vault", { ...completed, amountAtomic: "49999999" }, 50_000_000n),
    /valid completed state/,
  );
  assert.throws(
    () => finalizeVaultActivationResult(DIGEST, "kaspatest:funding", 86_000_000n, "kaspatest:vault", { ...completed, state: "submitted" }, 50_000_000n),
    /valid completed state/,
  );
});

test("completed vault activation is idempotent after the funding wallet has been drained", async () => {
  let executeCalls = 0;
  const completed = {
    operationKey: "bootstrap:existing",
    kind: "vault_deposit" as const,
    state: "completed" as const,
    summary: "done",
    destination: "kaspatest:vault",
    requestedAmountAtomic: "max" as const,
    keepFloatAtomic: "10000000",
    feeCeilingAtomic: "25000000",
    amountAtomic: "50000000",
    feeAtomic: "1000000",
    transactionId: TXID,
    retryCount: 0,
    recoveryRequired: false,
    safeToRetry: false,
    cancellationRequested: false,
    preparationFenced: false,
  };
  const result = await driveBootstrapVaultDeposit({
    status: () => completed,
    execute: async () => { executeCalls += 1; return completed; },
    recover: async () => completed,
  }, {
    operationKey: completed.operationKey,
    destination: completed.destination,
    fundingBalance: 10_000_000n,
    minimumFunding: 85_000_000n,
    keepFloat: 10_000_000n,
  });
  assert.equal(result, completed);
  assert.equal(executeCalls, 0);

  await assert.rejects(
    () => driveBootstrapVaultDeposit({
      status: () => { throw new JournalNotFoundError("missing"); },
      execute: async () => { executeCalls += 1; return completed; },
      recover: async () => completed,
    }, {
      operationKey: "bootstrap:new",
      destination: completed.destination,
      fundingBalance: 10_000_000n,
      minimumFunding: 85_000_000n,
      keepFloat: 10_000_000n,
    }),
    /needs at least 0\.85 tKAS/,
  );
  assert.equal(executeCalls, 0);
});
