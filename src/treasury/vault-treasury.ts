import type {
  TreasuryModule,
  TreasuryQuote,
  TreasuryStagingRecoveryModule,
} from "../purchase/coordinator.js";
import type { PolicyDefinition } from "../purchase/journal.js";
import type { CheckoutTerms } from "../purchase/types.js";

const TESTNET = "kaspa:testnet-10";

export interface VaultTreasuryStatus {
  /** Optional backend status hint; readiness is determined by covenantId. */
  readonly configured?: boolean;
  readonly covenantId?: string;
}

export interface VaultTreasuryModuleOptions {
  readonly vault: { configured: boolean; config(): VaultTreasuryStatus };
  /** Read for every reservation so operator policy changes fail closed immediately. */
  readonly policy: PolicyDefinition | (() => PolicyDefinition);
  /** Complete threshold + exact fee + staging fee authorization bound. */
  readonly additionalCostCeilingAtomic: string;
  readonly reservationTtlMs?: number;
  /** Protocol-aware preparation remains an adapter behind the Treasury seam. */
  readonly staging: Pick<
    TreasuryModule,
    "prepareStaging" | "submitStaging" | "observeStaging"
  >;
  readonly stagingRecovery: TreasuryStagingRecoveryModule;
}

/** Stable Purchase-facing policy/availability seam for the consensus vault. */
export class VaultTreasuryModule implements TreasuryModule {
  private readonly policyProvider: () => PolicyDefinition;
  private readonly additionalCostCeilingAtomic: string;
  private readonly reservationTtlMs: number;

  constructor(private readonly options: VaultTreasuryModuleOptions) {
    if (!options.vault) throw new Error("vault Treasury requires a vault backend");
    requireMethod(options.staging?.prepareStaging, "staging preparation");
    requireMethod(options.staging?.submitStaging, "staging submission");
    requireMethod(options.staging?.observeStaging, "staging observation");
    requireMethod(options.stagingRecovery?.prepare, "staging recovery preparation");
    requireMethod(options.stagingRecovery?.observe, "staging recovery observation");
    requireMethod(options.stagingRecovery?.submit, "staging recovery submission");
    const configuredPolicy = options.policy;
    this.policyProvider = typeof configuredPolicy === "function"
      ? configuredPolicy
      : () => configuredPolicy;
    canonicalPolicy(this.policyProvider());
    this.additionalCostCeilingAtomic = atomic(options.additionalCostCeilingAtomic, true, "additional-cost ceiling");
    this.reservationTtlMs = options.reservationTtlMs ?? 120_000;
    if (!Number.isSafeInteger(this.reservationTtlMs) || this.reservationTtlMs <= 0) {
      throw new Error("vault Treasury reservation TTL is invalid");
    }
  }

  async currentPolicy(): Promise<PolicyDefinition> {
    const policy = canonicalPolicy(this.policyProvider());
    return Object.freeze({
      ...policy,
      allowlist: Object.freeze([...policy.allowlist]),
    });
  }

  async quote(input: { terms: CheckoutTerms }): Promise<TreasuryQuote> {
    if (input.terms.asset !== "KAS" || input.terms.network !== TESTNET) {
      return Object.freeze({
        additionalCostCeilingAtomic: this.additionalCostCeilingAtomic,
        reservationTtlMs: this.reservationTtlMs,
        ready: false,
        blockerCode: "unsupported_asset_or_network",
      });
    }
    let configured: VaultTreasuryStatus;
    try {
      if (!this.options.vault.configured) {
        return Object.freeze({
          additionalCostCeilingAtomic: this.additionalCostCeilingAtomic,
          reservationTtlMs: this.reservationTtlMs,
          ready: false,
          blockerCode: "vault_not_configured",
        });
      }
      configured = this.options.vault.config();
    } catch {
      return Object.freeze({
        additionalCostCeilingAtomic: this.additionalCostCeilingAtomic,
        reservationTtlMs: this.reservationTtlMs,
        ready: false,
        blockerCode: "vault_unavailable",
      });
    }
    if (
      configured.covenantId !== undefined &&
      !/^[a-f0-9]{64}$/.test(configured.covenantId)
    ) {
      return Object.freeze({
        additionalCostCeilingAtomic: this.additionalCostCeilingAtomic,
        reservationTtlMs: this.reservationTtlMs,
        ready: false,
        blockerCode: "vault_unavailable",
      });
    }
    return Object.freeze({
      additionalCostCeilingAtomic: this.additionalCostCeilingAtomic,
      reservationTtlMs: this.reservationTtlMs,
      ready: Boolean(configured.covenantId),
      ...(configured.covenantId ? {} : { blockerCode: "vault_not_covenant_funded" }),
    });
  }

  async prepareStaging(
    input: Parameters<TreasuryModule["prepareStaging"]>[0]
  ): ReturnType<TreasuryModule["prepareStaging"]> {
    return this.options.staging.prepareStaging(input);
  }

  async submitStaging(
    input: Parameters<TreasuryModule["submitStaging"]>[0]
  ): ReturnType<TreasuryModule["submitStaging"]> {
    return this.options.staging.submitStaging(input);
  }

  async observeStaging(
    input: Parameters<TreasuryModule["observeStaging"]>[0]
  ): ReturnType<TreasuryModule["observeStaging"]> {
    return this.options.staging.observeStaging(input);
  }

  async prepareStagingRecovery(
    input: Parameters<TreasuryModule["prepareStagingRecovery"]>[0]
  ): ReturnType<TreasuryModule["prepareStagingRecovery"]> {
    return this.options.stagingRecovery.prepare(input);
  }

  async observeStagingRecovery(
    input: Parameters<TreasuryModule["observeStagingRecovery"]>[0]
  ): ReturnType<TreasuryModule["observeStagingRecovery"]> {
    return this.options.stagingRecovery.observe(input);
  }

  async submitStagingRecovery(
    input: Parameters<TreasuryModule["submitStagingRecovery"]>[0]
  ): ReturnType<TreasuryModule["submitStagingRecovery"]> {
    return this.options.stagingRecovery.submit(input);
  }
}

function requireMethod(value: unknown, label: string): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`vault Treasury ${label} adapter is required`);
  }
}

function canonicalPolicy(candidate: PolicyDefinition): PolicyDefinition {
  if (!candidate || !Array.isArray(candidate.allowlist)) throw new Error("vault Treasury policy is invalid");
  const allowlist = candidate.allowlist.map((value) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 256 ||
      value.trim() !== value ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error("vault Treasury allowlist entry is invalid");
    }
    return value;
  });
  if (new Set(allowlist).size !== allowlist.length) throw new Error("vault Treasury allowlist contains duplicates");
  return Object.freeze({
    maxPerPaymentAtomic: atomic(candidate.maxPerPaymentAtomic, false, "per-payment limit"),
    maxPerHourAtomic: atomic(candidate.maxPerHourAtomic, false, "hourly limit"),
    approvalAboveAtomic: atomic(candidate.approvalAboveAtomic, true, "approval threshold"),
    allowlist: Object.freeze([...allowlist].sort()),
  });
}

function atomic(value: string, zeroAllowed: boolean, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`vault Treasury ${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > (1n << 64n) - 1n || (!zeroAllowed && parsed === 0n)) {
    throw new Error(`vault Treasury ${label} is outside uint64 bounds`);
  }
  return value;
}
