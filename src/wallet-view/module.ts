import type { PolicyEngine } from "../policy.js";
import type { PurchaseJournal } from "../purchase/journal.js";
import type { TreasuryOperationModule } from "../treasury/operations.js";
import type { VaultManager } from "../vault.js";
import type { KaspaWallet } from "../wallet.js";

export interface WalletView {
  readonly network: "kaspa:testnet-10";
  readonly asset: "KAS";
  readonly fundingAddress: string;
  readonly vaultAddress: string;
  readonly vaultOutpoint?: Readonly<{ txid: string; index: number }>;
  readonly balance: Readonly<{
    observedAtomic: string;
    unboundAtomic: string;
    reservedAtomic: string;
    availableAtomic: string;
    provenance: "operator-node-and-local-vault-lineage";
    observedAt: string;
  }>;
  readonly limits: Readonly<{
    maxPerTransferAtomic: string;
    maxPerHourAtomic: string;
    approvalThresholdAtomic: string;
    allowlist: readonly string[];
    vaultMaxOutflowAtomic: string;
    vaultWindowSizeDaa: string;
    vaultSpentInWindowAtomic: string;
  }>;
  readonly chainStatus: "observed" | "unfunded" | "unavailable";
}

export type WalletActivityItem = Readonly<{
  kind: "purchase" | "transfer";
  id: string;
  requestKey: string;
  state: string;
  amountAtomic?: string;
  counterparty?: string;
  transactionId?: string;
  createdAt: string;
  updatedAt: string;
}>;

export class WalletViewModule {
  private readonly now: () => number;
  constructor(private readonly options: Readonly<{
    wallet: KaspaWallet;
    vault: Pick<VaultManager, "config" | "balanceBreakdown">;
    journal: Pick<PurchaseJournal, "listTransfers" | "listPurchases" | "findCheckoutTerms">;
    treasury: Pick<TreasuryOperationModule, "effectiveCapacityUsed">;
    policy: Pick<PolicyEngine, "policy">;
    now?: () => number;
  }>) {
    if (!options.wallet || !options.vault || !options.journal || !options.treasury || !options.policy) {
      throw new Error("Wallet View dependencies are incomplete");
    }
    this.now = options.now ?? Date.now;
  }

  async wallet(): Promise<WalletView> {
    const config = this.options.vault.config();
    const policy = this.options.policy.policy;
    const reserved = this.options.treasury.effectiveCapacityUsed();
    let observed = 0n;
    let unbound = 0n;
    let chainStatus: WalletView["chainStatus"] = config.covenantId ? "unavailable" : "unfunded";
    try {
      const balance = await this.options.vault.balanceBreakdown(this.options.wallet);
      observed = balance.spendableSompi;
      unbound = balance.unboundSompi;
      chainStatus = config.covenantId ? "observed" : "unfunded";
    } catch {
      // A read-only status request must report unavailable without inventing a balance.
    }
    const available = observed > reserved ? observed - reserved : 0n;
    return Object.freeze({
      network: "kaspa:testnet-10",
      asset: "KAS",
      fundingAddress: this.options.wallet.address,
      vaultAddress: config.address,
      ...(config.currentOutpoint ? { vaultOutpoint: Object.freeze({ ...config.currentOutpoint }) } : {}),
      balance: Object.freeze({
        observedAtomic: observed.toString(),
        unboundAtomic: unbound.toString(),
        reservedAtomic: reserved.toString(),
        availableAtomic: available.toString(),
        provenance: "operator-node-and-local-vault-lineage",
        observedAt: new Date(this.timestamp()).toISOString(),
      }),
      limits: Object.freeze({
        maxPerTransferAtomic: policy.maxSompiPerTx.toString(),
        maxPerHourAtomic: policy.maxSompiPerHour.toString(),
        approvalThresholdAtomic: policy.requireApprovalAboveSompi.toString(),
        allowlist: Object.freeze([...policy.allowlist]),
        vaultMaxOutflowAtomic: config.maxOutflowSompi,
        vaultWindowSizeDaa: config.windowSizeDaa,
        vaultSpentInWindowAtomic: config.spentInWindowSompi,
      }),
      chainStatus,
    });
  }

  activity(limit = 20): readonly WalletActivityItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Wallet activity limit must be between 1 and 100");
    }
    const transfers: WalletActivityItem[] = this.options.journal.listTransfers(limit).map((transfer) => Object.freeze({
      kind: "transfer" as const,
      id: transfer.id,
      requestKey: transfer.requestKey,
      state: transfer.state,
      amountAtomic: transfer.amountAtomic,
      counterparty: transfer.destination,
      ...(transfer.transactionId ? { transactionId: transfer.transactionId } : {}),
      createdAt: new Date(transfer.createdAtMs).toISOString(),
      updatedAt: new Date(transfer.updatedAtMs).toISOString(),
    }));
    const purchases: WalletActivityItem[] = this.options.journal.listPurchases(limit).map((purchase) => {
      const terms = this.options.journal.findCheckoutTerms(purchase.id);
      return Object.freeze({
        kind: "purchase" as const,
        id: purchase.id,
        requestKey: purchase.requestKey,
        state: purchase.state,
        ...(terms ? { amountAtomic: terms.amountAtomic, counterparty: terms.payTo } : {}),
        createdAt: new Date(purchase.createdAtMs).toISOString(),
        updatedAt: new Date(purchase.updatedAtMs).toISOString(),
      });
    });
    return Object.freeze([...transfers, ...purchases]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, limit));
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Wallet View clock is unavailable");
    return value;
  }
}
