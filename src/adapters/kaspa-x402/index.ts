/**
 * Concrete Kaspa-x402 alpha.8 adapter surface. Sompi intentionally exposes
 * only its pinned testnet-10 profiles here; the Purchase domain remains
 * independent of these protocol-specific types.
 */
export { KaspaTestnet10AddressCodec } from "./address-codec.js";
export { SecureBatchChannelSigner } from "./batch-channel-signer.js";
export { JournalBatchChannelStore } from "./batch-channel-store.js";
export {
  KaspaX402BatchCapitalModule,
  type BatchChannelCapitalResult,
  type OpenBatchChannelRequest,
} from "./batch-capital-module.js";
export {
  KaspaX402BatchClaimBuilder,
  type BatchClaimDigestSigner,
  type BatchClaimFeeSource,
} from "./batch-claim-builder.js";
export {
  BatchRefundTreasuryOperationAdapter,
  KaspaX402BatchRefundModule,
} from "./batch-refund.js";
export {
  HttpsBatchClaimRaceSource,
  type BatchClaimRaceObservation,
  type BatchClaimRaceSource,
} from "./batch-race-source.js";
export {
  JournalBatchVoucherAuthorizer,
  KaspaX402BatchPaymentModule,
  type AppliedBatchSettlement,
  type BatchActiveUtxoSource,
  type PrepareBatchPaymentInput,
  type PreparedBatchPayment,
} from "./batch-payment-module.js";
export { KaspaX402PaymentModule } from "./payment-module.js";
export {
  WalletBatchChainSource,
  type WalletBatchChainRpcProvider,
} from "./wallet-batch-chain-source.js";
export * from "./abandoned-staging-recovery.js";
export * from "./chain-verifier.js";
export * from "./authority-evidence-verifier.js";
export * from "./payment-requirements-verifier.js";
export * from "./exact-attempt-funding-bridge.js";
export {
  KaspaX402ExactPaymentModule,
  KaspaX402TreasuryStagingAdapter,
  KaspaX402AdapterError,
  type TreasuryStagingDriver,
  type ExactAttemptFundingBridge,
  type ExactAttemptFundingContext,
  type ExactSettlementVerifier,
  type KaspaExactRecoveryObserver,
} from "./exact-payment-module.js";
export {
  ExactTransactionBuilder,
  SOMPI_EXACT_FEE_POLICY,
  type BuildExactTransactionInput,
  type ExactTransactionBuilderOptions,
  type ObservedStagingOutput,
} from "./exact-transaction-builder.js";
export {
  StagingKeyStore,
  stagingKeyReference,
  type StagingKeyBinding,
  type StagingKeyLookup,
  type StagingKeyRecord,
  type StagingKeyStoreOptions,
} from "./staging-key-store.js";
export * from "./staging-recovery-rpc.js";
export * from "./staging-recovery-module.js";
export * from "./vault-treasury-staging.js";
export {
  VaultTreasuryFundingProvider,
  type VaultTreasuryFundingProviderOptions,
} from "./vault-treasury-funding-provider.js";
