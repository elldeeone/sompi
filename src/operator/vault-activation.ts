import { sompiRuntimeConfigFromEnv } from "../runtime/config.js";
import { createSompiBootstrapRuntime } from "../runtime/purchase-runtime.js";
import { JournalNotFoundError } from "../journal/contracts.js";
import type { TreasuryOperationView } from "../treasury/operations.js";
import { displayKas } from "../amount-display.js";
import { HostBootstrapError } from "./host-bootstrap.js";

const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const ATOMIC = /^[1-9][0-9]*$/;
const RECOVERY_ATTEMPTS = 120;

export interface VaultActivationResult {
  readonly status: "ready";
  readonly requestDigest: string;
  readonly fundingAddress: string;
  readonly fundingBalanceObservedSompi: string;
  readonly vaultAddress: string;
  readonly vaultDepositSompi: string;
  readonly feeSompi: string;
  readonly transactionId: string;
}

interface BootstrapTreasuryOperations {
  status(operationKey: string): TreasuryOperationView;
  execute(request: Readonly<{
    operationKey: string;
    kind: "vault_deposit";
    destination: string;
    amountAtomic: "max";
    keepFloatAtomic: string;
  }>): Promise<TreasuryOperationView>;
  recover(operationKey: string): Promise<TreasuryOperationView>;
}

/** Run only as the isolated API principal under sompi-vault-activate.service. */
export async function activateBootstrapVault(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VaultActivationResult> {
  const expectedUid = numericEnv(env.SOMPI_API_UID, "API UID");
  if (typeof process.getuid !== "function" || process.getuid() !== expectedUid || expectedUid === 0) {
    throw new HostBootstrapError("vault activation worker must run as the isolated API principal");
  }
  const requestDigest = env.SOMPI_BOOTSTRAP_REQUEST_DIGEST;
  if (!requestDigest || !DIGEST.test(requestDigest)) throw new HostBootstrapError("vault activation request digest is invalid");
  const minimumFunding = atomicEnv(env.SOMPI_BOOTSTRAP_MINIMUM_FUNDING_SOMPI, "minimum funding");
  const minimumDeposit = atomicEnv(env.SOMPI_BOOTSTRAP_MINIMUM_DEPOSIT_SOMPI, "minimum vault deposit");
  const keepFloat = atomicEnv(env.SOMPI_BOOTSTRAP_KEEP_FLOAT_SOMPI, "funding-wallet float");
  const runtime = createSompiBootstrapRuntime(sompiRuntimeConfigFromEnv(env));
  try {
    const fundingBalance = await runtime.wallet.balanceSompi();
    const config = runtime.vault.config();
    const operationKey = `bootstrap:vault-deposit:${requestDigest.slice("sha256:".length)}`;
    const view = await driveBootstrapVaultDeposit(runtime.treasuryOperations, {
      operationKey,
      destination: config.address,
      fundingBalance,
      minimumFunding,
      keepFloat,
    });
    return finalizeVaultActivationResult(requestDigest, runtime.wallet.address, fundingBalance, config.address, view, minimumDeposit);
  } finally {
    await runtime.close();
  }
}

export async function driveBootstrapVaultDeposit(
  operations: BootstrapTreasuryOperations,
  input: Readonly<{
    operationKey: string;
    destination: string;
    fundingBalance: bigint;
    minimumFunding: bigint;
    keepFloat: bigint;
  }>,
): Promise<TreasuryOperationView> {
  let view: TreasuryOperationView;
  try {
    view = operations.status(input.operationKey);
  } catch (error) {
    if (!(error instanceof JournalNotFoundError)) throw error;
    if (input.fundingBalance < input.minimumFunding) {
      throw new HostBootstrapError(`funding wallet needs at least ${displayKas(input.minimumFunding)} before vault activation`);
    }
    view = await operations.execute({
      operationKey: input.operationKey,
      kind: "vault_deposit",
      destination: input.destination,
      amountAtomic: "max",
      keepFloatAtomic: input.keepFloat.toString(),
    });
  }
  for (let attempt = 0; view.state !== "completed" && attempt < RECOVERY_ATTEMPTS; attempt += 1) {
    if (view.state === "failed_terminal") throw new HostBootstrapError("vault activation failed terminally");
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    view = await operations.recover(input.operationKey);
  }
  return view;
}

export function finalizeVaultActivationResult(
  requestDigest: string,
  fundingAddress: string,
  fundingBalance: bigint,
  vaultAddress: string,
  view: TreasuryOperationView,
  minimumDeposit: bigint,
): VaultActivationResult {
  if (
    view.state !== "completed" ||
    !view.amountAtomic || BigInt(view.amountAtomic) < minimumDeposit ||
    !view.feeAtomic || !view.transactionId || !/^[a-f0-9]{64}$/.test(view.transactionId)
  ) {
    throw new HostBootstrapError("vault activation did not reach a valid completed state");
  }
  return Object.freeze({
    status: "ready",
    requestDigest,
    fundingAddress,
    fundingBalanceObservedSompi: fundingBalance.toString(),
    vaultAddress,
    vaultDepositSompi: view.amountAtomic,
    feeSompi: view.feeAtomic,
    transactionId: view.transactionId,
  });
}

function atomicEnv(value: string | undefined, label: string): bigint {
  if (!value || !ATOMIC.test(value)) throw new HostBootstrapError(`vault activation ${label} is invalid`);
  return BigInt(value);
}

function numericEnv(value: string | undefined, label: string): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new HostBootstrapError(`vault activation ${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0x7fffffff) throw new HostBootstrapError(`vault activation ${label} is invalid`);
  return parsed;
}
