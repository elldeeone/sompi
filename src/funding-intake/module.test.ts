import assert from "node:assert/strict";
import test from "node:test";

import type { TreasuryOperationView } from "../treasury/operation-journal.js";
import type { FundingUtxo } from "../wallet.js";
import { FundingIntakeModule, startFundingIntake } from "./module.js";

const RECEIVE = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const VAULT = "kaspatest:qrxeq3nwsc90spysdga0flxsujzkypg8ngnllcek4efhpfy2ghm2w0c3sfrw4";

test("Funding Intake is idle with no funds and reports node unavailability honestly", async () => {
  const empty = fixture();
  assert.equal((await empty.module.status()).state, "idle");
  const unavailable = fixture({ unavailable: true });
  const status = await unavailable.module.status();
  assert.equal(status.state, "unavailable");
  assert.equal(status.userAction, "wait");
  assert.equal(status.incomingAtomic, "0");
});

test("Funding Intake detects small funds without creating an uneconomic deposit", async () => {
  const setup = fixture({ utxos: [utxo("1", 0, "100")] });
  const status = await setup.module.reconcile();
  assert.equal(status.state, "detected");
  assert.match(status.summary, /enough to cover/);
  assert.equal(setup.executeCalls.length, 0);
});

test("Funding Intake automatically deposits eligible funds once with a deterministic key", async () => {
  const setup = fixture({ utxos: [utxo("2", 1, "500000000")] });
  const first = await setup.module.reconcile();
  const second = await setup.module.reconcile();
  assert.equal(setup.executeCalls.length, 2);
  assert.equal(setup.executeCalls[0].operationKey, setup.executeCalls[1].operationKey);
  assert.match(String(setup.executeCalls[0].operationKey), /^funding-intake:/);
  assert.deepEqual(setup.executeCalls[0], {
    operationKey: setup.executeCalls[0].operationKey,
    kind: "vault_deposit",
    destination: VAULT,
    amountAtomic: "max",
    keepFloatAtomic: "0",
  });
  assert.equal(first.operation?.state, "completed");
  assert.equal(second.operation?.state, "completed");
});

test("Funding Intake recovers its own operation and waits behind other Treasury work", async () => {
  const pending = operation("funding-intake:pending", "submitted");
  const own = fixture({ utxos: [utxo("3", 0, "500000000")], recent: [pending] });
  assert.equal((await own.module.reconcile()).operation?.state, "completed");
  assert.deepEqual(own.recoverCalls, [pending.operationKey]);

  const busy = fixture({ utxos: [utxo("4", 0, "500000000")], unresolved: 1 });
  const status = await busy.module.reconcile();
  assert.equal(status.state, "detected");
  assert.match(status.summary, /current wallet operation/);
  assert.equal(busy.executeCalls.length, 0);
});

test("Funding Intake runner starts immediately, serializes work, and closes cleanly", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const running = startFundingIntake({
    async reconcile() {
      calls += 1;
      await blocked;
      return {} as never;
    },
  }, { intervalMs: 1_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await running.close();
  assert.equal(calls, 1);
});

function fixture(input: Readonly<{
  utxos?: readonly FundingUtxo[];
  unavailable?: boolean;
  unresolved?: number;
  recent?: readonly TreasuryOperationView[];
}> = {}) {
  const executeCalls: Array<Record<string, unknown>> = [];
  const recoverCalls: string[] = [];
  const recent = [...(input.recent ?? [])];
  const module = new FundingIntakeModule({
    wallet: {
      address: RECEIVE,
      async fundingUtxos() {
        if (input.unavailable) throw new Error("node unavailable");
        return input.utxos ?? [];
      },
    },
    vault: { config: () => ({ address: VAULT, covenantId: "11".repeat(32) }) } as never,
    treasury: {
      authorizationContext: () => ({ policyDigest: `sha256:${"A".repeat(43)}`, feeCeilingAtomic: "100" }),
      unresolvedCount: () => input.unresolved ?? 0,
      recent: () => recent,
      async execute(request: Record<string, unknown>) {
        executeCalls.push(request);
        const completed = operation(String(request.operationKey), "completed");
        recent.unshift(completed);
        return completed;
      },
      async recover(key: string) {
        recoverCalls.push(key);
        const completed = operation(key, "completed");
        recent.splice(0, recent.length, completed);
        return completed;
      },
    } as never,
  });
  return { module, executeCalls, recoverCalls };
}

function utxo(seed: string, index: number, amountAtomic: string): FundingUtxo {
  return Object.freeze({ transactionId: seed.padStart(64, "0"), index, amountAtomic });
}

function operation(operationKey: string, state: TreasuryOperationView["state"]): TreasuryOperationView {
  return Object.freeze({
    operationKey, kind: "vault_deposit", state, summary: state, destination: VAULT,
    requestedAmountAtomic: "max", keepFloatAtomic: "0", feeCeilingAtomic: "100",
    amountAtomic: "499999900", feeAtomic: "100", transactionId: "9".repeat(64), retryCount: 0,
    recoveryRequired: state === "submitted", safeToRetry: false, cancellationRequested: false,
    preparationFenced: false, createdAtMs: 1_900_000_000_000, updatedAtMs: 1_900_000_000_001,
  });
}
