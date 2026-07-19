import { createHash } from "node:crypto";

import type { TreasuryOperationModule, TreasuryOperationView } from "../treasury/operations.js";
import type { VaultManager } from "../vault.js";
import type { FundingUtxo, KaspaWallet } from "../wallet.js";

const PREFIX = "funding-intake:";
const DEFAULT_INTERVAL_MS = 15_000;

export type FundingIntakeState =
  | "idle"
  | "detected"
  | "securing"
  | "attention"
  | "unavailable";

export interface FundingIntakeStatus {
  readonly state: FundingIntakeState;
  readonly automatic: true;
  readonly incomingAtomic: string;
  readonly minimumToSecureAtomic: string;
  readonly summary: string;
  readonly userAction: "none" | "wait" | "operator";
  readonly incomingUtxos: readonly FundingUtxo[];
  readonly operation?: TreasuryOperationView;
}

type FundingRead = Readonly<{
  available: boolean;
  utxos: readonly FundingUtxo[];
}>;

export interface FundingIntakeModuleOptions {
  readonly wallet: Pick<KaspaWallet, "address" | "fundingUtxos">;
  readonly vault: Pick<VaultManager, "config">;
  readonly treasury: Pick<
    TreasuryOperationModule,
    "authorizationContext" | "execute" | "recover" | "recent" | "unresolvedCount"
  >;
}

/**
 * Deep module for receive-address detection and authority-narrowing vault deposits.
 * It can only drive the existing journal-first `vault_deposit` path.
 */
export class FundingIntakeModule {
  private active?: Promise<FundingIntakeStatus>;

  constructor(private readonly options: FundingIntakeModuleOptions) {
    if (!options.wallet || !options.vault || !options.treasury) {
      throw new Error("Funding Intake dependencies are incomplete");
    }
  }

  async status(): Promise<FundingIntakeStatus> {
    const funding = await this.readFundingUtxos();
    return funding.available
      ? this.snapshot(funding.utxos)
      : this.snapshot([], undefined, "unavailable", "The receive balance cannot be checked right now.");
  }

  reconcile(signal?: AbortSignal): Promise<FundingIntakeStatus> {
    this.active ??= this.drive(signal).finally(() => { this.active = undefined; });
    return this.active;
  }

  private async drive(signal?: AbortSignal): Promise<FundingIntakeStatus> {
    signal?.throwIfAborted();
    const config = this.options.vault.config();
    if (!config.covenantId) {
      const funding = await this.readFundingUtxos();
      if (!funding.available) return this.unavailable();
      return this.snapshot(funding.utxos, undefined, "attention", "Initial vault activation is required before incoming funds can be secured.");
    }

    const latest = this.latestOperation();
    if (latest && !terminal(latest.state)) {
      const recovered = await this.options.treasury.recover(latest.operationKey, signal);
      const funding = await this.readFundingUtxos();
      return funding.available ? this.snapshot(funding.utxos, recovered) : this.unavailable(recovered);
    }

    const funding = await this.readFundingUtxos();
    if (!funding.available) return this.unavailable();
    const incoming = funding.utxos;
    const incomingTotal = sum(incoming);
    const context = this.options.treasury.authorizationContext();
    const minimum = BigInt(context.feeCeilingAtomic) + 1n;
    if (incomingTotal === 0n || incomingTotal < minimum) return this.snapshot(incoming);

    // Do not compete with a Transfer or another direct Treasury Movement.
    if (this.options.treasury.unresolvedCount() > 0) {
      return this.snapshot(incoming, undefined, "detected", "Incoming funds are waiting for the current wallet operation to finish.");
    }
    const operationKey = fundingOperationKey(
      incoming,
      config.address,
      context.policyDigest,
      context.feeCeilingAtomic,
    );
    const operation = await this.options.treasury.execute({
      operationKey,
      kind: "vault_deposit",
      destination: config.address,
      amountAtomic: "max",
      keepFloatAtomic: "0",
    }, signal);
    const after = await this.readFundingUtxos();
    return after.available ? this.snapshot(after.utxos, operation) : this.unavailable(operation);
  }

  private latestOperation(): TreasuryOperationView | undefined {
    return this.options.treasury.recent("vault_deposit", 100)
      .find((operation) => operation.operationKey.startsWith(PREFIX));
  }

  private async readFundingUtxos(): Promise<FundingRead> {
    try {
      return Object.freeze({ available: true, utxos: await this.options.wallet.fundingUtxos() });
    } catch {
      return Object.freeze({ available: false, utxos: Object.freeze([]) });
    }
  }

  private unavailable(operation?: TreasuryOperationView): FundingIntakeStatus {
    return this.snapshot(
      [],
      operation,
      "unavailable",
      "The receive balance cannot be checked right now.",
    );
  }

  private snapshot(
    incoming: readonly FundingUtxo[],
    explicitOperation?: TreasuryOperationView,
    explicitState?: FundingIntakeState,
    explicitSummary?: string,
  ): FundingIntakeStatus {
    const context = this.options.treasury.authorizationContext();
    const incomingAtomic = sum(incoming).toString();
    const operation = explicitOperation ?? this.latestOperation();
    let state: FundingIntakeState = explicitState ?? "idle";
    let summary = explicitSummary ?? "No incoming funds are waiting to be secured.";
    let userAction: FundingIntakeStatus["userAction"] = "none";

    if (!explicitState && operation && !terminal(operation.state)) {
      state = "securing";
      summary = "Incoming funds are being secured in the spending-limited vault.";
      userAction = "wait";
    } else if (!explicitState && operation?.state === "failed_terminal" && BigInt(incomingAtomic) > 0n) {
      state = "attention";
      summary = "Incoming funds are safe at the receive address, but automatic securing needs operator attention.";
      userAction = "operator";
    } else if (!explicitState && BigInt(incomingAtomic) > 0n) {
      state = "detected";
      const minimum = BigInt(context.feeCeilingAtomic) + 1n;
      summary = BigInt(incomingAtomic) < minimum
        ? "Incoming funds are visible and will be secured once there is enough to cover the capped network fee."
        : "Incoming funds were detected and are queued for automatic securing.";
      userAction = BigInt(incomingAtomic) < minimum ? "none" : "wait";
    } else if (explicitState === "attention") {
      userAction = "operator";
    } else if (explicitState === "unavailable") {
      userAction = "wait";
    }

    return Object.freeze({
      state,
      automatic: true,
      incomingAtomic,
      minimumToSecureAtomic: (BigInt(context.feeCeilingAtomic) + 1n).toString(),
      summary,
      userAction,
      incomingUtxos: Object.freeze([...incoming]),
      ...(operation ? { operation } : {}),
    });
  }
}

export interface RunningFundingIntake {
  close(): Promise<void>;
}

export function startFundingIntake(
  intake: Pick<FundingIntakeModule, "reconcile">,
  options: Readonly<{ intervalMs?: number; onError?: (error: unknown) => void }> = {},
): RunningFundingIntake {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 10 * 60_000) {
    throw new Error("Funding Intake interval is invalid");
  }
  let closed = false;
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (closed || active) return;
    active = intake.reconcile().catch((error) => options.onError?.(error)).finally(() => { active = undefined; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return Object.freeze({
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  });
}

function fundingOperationKey(
  utxos: readonly FundingUtxo[],
  vaultAddress: string,
  policyDigest: string,
  feeCeilingAtomic: string,
): string {
  const canonical = JSON.stringify({
    profile: "sompi.funding-intake.1",
    receiveOutpoints: utxos.map((entry) => [entry.transactionId, entry.index, entry.amountAtomic]),
    vaultAddress,
    policyDigest,
    feeCeilingAtomic,
  });
  return `${PREFIX}${createHash("sha256").update(canonical).digest("base64url")}`;
}

function terminal(state: TreasuryOperationView["state"]): boolean {
  return state === "completed" || state === "failed_terminal";
}

function sum(utxos: readonly FundingUtxo[]): bigint {
  return utxos.reduce((total, utxo) => total + BigInt(utxo.amountAtomic), 0n);
}
