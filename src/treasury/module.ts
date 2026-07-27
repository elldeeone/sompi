import type {
  ReservePurchaseCapacityInput,
  ReservePurchaseCapacityResult,
  TreasuryQuote,
  TreasuryQuoteInput,
} from "./purchase-capacity.js";
import type {
  ExecutePurchaseStagingInput,
  PreparePurchaseStagingInput,
  TreasuryStagingExecutionResult,
  TreasuryStagingOutput,
  TreasuryStagingPreparationResult,
} from "./purchase-staging.js";
import type {
  PurchaseStagingRecoveryResult,
  RecoverPurchaseStagingInput,
} from "./staging-recovery.js";

/**
 * Deep Treasury module. Purchase supplies only stable Sompi intent and identity
 * facts. Treasury owns policy capacity, staging, and staging recovery.
 */
export interface TreasuryModule {
  quote(input: Readonly<TreasuryQuoteInput>): Promise<Readonly<TreasuryQuote>>;
  reservePurchaseCapacity(
    input: Readonly<ReservePurchaseCapacityInput>,
  ): Promise<Readonly<ReservePurchaseCapacityResult>>;
  preparePurchaseStaging(
    input: Readonly<PreparePurchaseStagingInput>,
  ): Promise<Readonly<TreasuryStagingPreparationResult>>;
  executePurchaseStaging(
    input: Readonly<ExecutePurchaseStagingInput>,
  ): Promise<Readonly<TreasuryStagingExecutionResult>>;
  getPurchaseStaging(
    input: Readonly<ExecutePurchaseStagingInput>,
  ): Promise<Readonly<TreasuryStagingOutput> | undefined>;
  recoverPurchaseStaging(
    input: Readonly<RecoverPurchaseStagingInput>,
  ): Promise<Readonly<PurchaseStagingRecoveryResult>>;
}
