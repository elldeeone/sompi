import { kasAmountView, type KasAmountView } from "../amount-display.js";
import type { FundingIntakeModule, FundingIntakeStatus } from "../funding-intake/module.js";
import type { PolicyEngine } from "../policy.js";
import type { PurchaseJournal } from "../purchase/journal.js";
import type { TreasuryOperationModule } from "../treasury/operations.js";
import type { VaultManager } from "../vault.js";
import type { KaspaWallet } from "../wallet.js";

export interface WalletView {
  readonly network: "kaspa:testnet-10";
  readonly asset: "KAS";
  readonly receive: Readonly<{
    address: string;
    qrPayload: string;
    networkLabel: "Kaspa Testnet-10";
    warning: "Testnet funds only — do not send mainnet KAS.";
  }>;
  readonly balance: Readonly<{
    total: KasAmountView;
    available: KasAmountView;
    incoming: KasAmountView;
    protected: KasAmountView;
    pending: KasAmountView;
    provenance: "operator-node-and-local-vault-lineage";
    observedAt: string;
  }>;
  readonly securing: Readonly<{
    automatic: true;
    state: FundingIntakeStatus["state"];
    summary: string;
    userAction: FundingIntakeStatus["userAction"];
    minimumAmount: KasAmountView;
    operationId?: string;
    transactionId?: string;
  }>;
  readonly limits: Readonly<{
    perTransfer: KasAmountView;
    perHour: KasAmountView;
    approvalThreshold: KasAmountView;
    allowlist: readonly string[];
    vaultWindow: Readonly<{
      maximumOutflow: KasAmountView;
      spent: KasAmountView;
      sizeDaa: string;
    }>;
  }>;
  readonly security: Readonly<{
    vaultAddress: string;
    vaultOutpoint?: Readonly<{ txid: string; index: number }>;
  }>;
  readonly chainStatus: "observed" | "unfunded" | "unavailable";
}

export type WalletActivityItem = Readonly<{
  kind: "incoming" | "securing" | "purchase" | "transfer";
  direction: "incoming" | "internal" | "outgoing";
  id: string;
  requestKey?: string;
  state: string;
  summary: string;
  amount?: KasAmountView;
  fee?: KasAmountView;
  counterparty?: string;
  transactionId?: string;
  occurredAt: string;
}>;

export class WalletViewModule {
  private readonly now: () => number;
  constructor(private readonly options: Readonly<{
    wallet: KaspaWallet;
    vault: Pick<VaultManager, "config" | "balanceBreakdown">;
    fundingIntake: Pick<FundingIntakeModule, "status">;
    journal: Pick<PurchaseJournal, "listTransfers" | "listPurchases" | "findCheckoutTerms" | "findSettlementForPurchase">;
    treasury: Pick<TreasuryOperationModule, "pendingCapacityUsed" | "recent">;
    policy: Pick<PolicyEngine, "policy">;
    now?: () => number;
  }>) {
    if (!options.wallet || !options.vault || !options.fundingIntake || !options.journal || !options.treasury || !options.policy) {
      throw new Error("Wallet View dependencies are incomplete");
    }
    this.now = options.now ?? Date.now;
  }

  async wallet(): Promise<WalletView> {
    const config = this.options.vault.config();
    const policy = this.options.policy.policy;
    const reserved = this.options.treasury.pendingCapacityUsed();
    let protectedAmount = 0n;
    let chainStatus: WalletView["chainStatus"] = config.covenantId ? "unavailable" : "unfunded";
    try {
      const balance = await this.options.vault.balanceBreakdown(this.options.wallet);
      protectedAmount = balance.spendableSompi;
      chainStatus = config.covenantId ? "observed" : "unfunded";
    } catch {
      // A read-only status request reports unavailable without inventing a balance.
    }
    const intake = await this.options.fundingIntake.status();
    if (intake.state === "unavailable") chainStatus = "unavailable";
    const incoming = BigInt(intake.incomingAtomic);
    const available = protectedAmount > reserved ? protectedAmount - reserved : 0n;
    const observedAt = new Date(this.timestamp()).toISOString();
    return Object.freeze({
      network: "kaspa:testnet-10",
      asset: "KAS",
      receive: Object.freeze({
        address: this.options.wallet.address,
        qrPayload: this.options.wallet.address,
        networkLabel: "Kaspa Testnet-10" as const,
        warning: "Testnet funds only — do not send mainnet KAS." as const,
      }),
      balance: Object.freeze({
        total: kasAmountView(protectedAmount + incoming),
        available: kasAmountView(available),
        incoming: kasAmountView(incoming),
        protected: kasAmountView(protectedAmount),
        pending: kasAmountView(reserved),
        provenance: "operator-node-and-local-vault-lineage" as const,
        observedAt,
      }),
      securing: Object.freeze({
        automatic: true as const,
        state: intake.state,
        summary: intake.summary,
        userAction: intake.userAction,
        minimumAmount: kasAmountView(intake.minimumToSecureAtomic),
        ...(intake.operation ? { operationId: intake.operation.operationKey } : {}),
        ...(intake.operation?.transactionId ? { transactionId: intake.operation.transactionId } : {}),
      }),
      limits: Object.freeze({
        perTransfer: kasAmountView(policy.maxSompiPerTx),
        perHour: kasAmountView(policy.maxSompiPerHour),
        approvalThreshold: kasAmountView(policy.requireApprovalAboveSompi),
        allowlist: Object.freeze([...policy.allowlist]),
        vaultWindow: Object.freeze({
          maximumOutflow: kasAmountView(config.maxOutflowSompi),
          spent: kasAmountView(config.spentInWindowSompi),
          sizeDaa: config.windowSizeDaa,
        }),
      }),
      security: Object.freeze({
        vaultAddress: config.address,
        ...(config.currentOutpoint ? { vaultOutpoint: Object.freeze({ ...config.currentOutpoint }) } : {}),
      }),
      chainStatus,
    });
  }

  async activity(limit = 20): Promise<readonly WalletActivityItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Wallet activity limit must be between 1 and 100");
    }
    const observedAt = new Date(this.timestamp()).toISOString();
    const intake = await this.options.fundingIntake.status();
    const incoming: WalletActivityItem[] = intake.incomingUtxos.map((utxo) => Object.freeze({
      kind: "incoming" as const,
      direction: "incoming" as const,
      id: `incoming:${utxo.transactionId}:${utxo.index}`,
      state: "detected",
      summary: `${kasAmountView(utxo.amountAtomic).display} received and waiting to be secured.`,
      amount: kasAmountView(utxo.amountAtomic),
      transactionId: utxo.transactionId,
      occurredAt: observedAt,
    }));
    const securing: WalletActivityItem[] = this.options.treasury.recent("vault_deposit", limit)
      .filter((operation) => operation.operationKey.startsWith("funding-intake:"))
      .map((operation) => Object.freeze({
        kind: "securing" as const,
        direction: "internal" as const,
        id: operation.operationKey,
        state: operation.state,
        summary: operation.state === "completed"
          ? `${kasAmountView(operation.amountAtomic ?? "0").display} secured in the spending-limited vault.`
          : operation.state === "failed_terminal"
            ? "Automatic securing needs operator attention; funds remain at the receive address."
            : "Incoming funds are being secured in the spending-limited vault.",
        ...(operation.amountAtomic ? { amount: kasAmountView(operation.amountAtomic) } : {}),
        ...(operation.feeAtomic ? { fee: kasAmountView(operation.feeAtomic) } : {}),
        ...(operation.transactionId ? { transactionId: operation.transactionId } : {}),
        occurredAt: new Date(operation.createdAtMs ?? this.timestamp()).toISOString(),
      }));
    const transfers: WalletActivityItem[] = this.options.journal.listTransfers(limit).map((transfer) => Object.freeze({
      kind: "transfer" as const,
      direction: "outgoing" as const,
      id: transfer.id,
      requestKey: transfer.requestKey,
      state: transfer.state,
      summary: `${kasAmountView(transfer.amountAtomic).display} transfer to ${transfer.destination}.`,
      amount: kasAmountView(transfer.amountAtomic),
      ...(transfer.actualFeeAtomic ? { fee: kasAmountView(transfer.actualFeeAtomic) } : {}),
      counterparty: transfer.destination,
      ...(transfer.transactionId ? { transactionId: transfer.transactionId } : {}),
      occurredAt: new Date(transfer.createdAtMs).toISOString(),
    }));
    const purchases: WalletActivityItem[] = this.options.journal.listPurchases(limit).map((purchase) => {
      const terms = this.options.journal.findCheckoutTerms(purchase.id);
      const settlement = this.options.journal.findSettlementForPurchase(purchase.id);
      return Object.freeze({
        kind: "purchase" as const,
        direction: "outgoing" as const,
        id: purchase.id,
        requestKey: purchase.requestKey,
        state: purchase.state,
        summary: terms
          ? `${kasAmountView(terms.amountAtomic).display} purchase from ${terms.merchant.name}.`
          : "Purchase recorded; payment terms are not yet available.",
        ...(terms ? { amount: kasAmountView(terms.amountAtomic), counterparty: terms.merchant.origin } : {}),
        ...(settlement ? {
          fee: kasAmountView(settlement.actualAdditionalCostAtomic),
          ...(settlement.transactionId ? { transactionId: settlement.transactionId } : {}),
        } : {}),
        occurredAt: new Date(purchase.createdAtMs).toISOString(),
      });
    });
    return Object.freeze([...incoming, ...securing, ...transfers, ...purchases]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id))
      .slice(0, limit));
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Wallet View clock is unavailable");
    return value;
  }
}
