/**
 * Concrete Kaspa-x402 alpha.6 adapter surface. Sompi intentionally exposes
 * only its pinned testnet-10 exact profile here; the Purchase domain remains
 * independent of these protocol-specific types.
 */
export { KaspaTestnet10AddressCodec } from "./address-codec.js";
export { ExactOnlyChannelSigner } from "./exact-only-channel-signer.js";
export { ExactOnlyChannelStore } from "./exact-only-channel-store.js";
export * from "./abandoned-staging-recovery.js";
export * from "./chain-verifier.js";
export * from "./payment-requirements-verifier.js";
export * from "./exact-attempt-funding-bridge.js";
export {
  KaspaX402ExactPaymentModule,
  KaspaX402AdapterError,
  type DurableTreasuryStagingSeam,
  type ExactAttemptFundingBridge,
  type ExactAttemptFundingContext,
  type ExactSettlementVerifier,
  type KaspaExactRecoveryObserver,
} from "./exact-payment-module.js";
export {
  Kip10ExactTransactionBuilder,
  SOMPI_EXACT_FEE_POLICY,
  minimumRequiredExactFeeSompi,
  type BuildKip10ExactTransactionInput,
  type Kip10ExactTransactionBuilderOptions,
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
