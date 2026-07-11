/**
 * Concrete Kaspa-x402 alpha.6 adapter surface. Sompi intentionally exposes
 * only its pinned testnet-10 exact profile here; the Purchase domain remains
 * independent of these protocol-specific types.
 */
export { KaspaTestnet10AddressCodec } from "./address-codec.js";
export { ExactOnlyChannelSigner } from "./exact-only-channel-signer.js";
export { ExactOnlyChannelStore } from "./exact-only-channel-store.js";
export {
  Kip10ExactTransactionBuilder,
  SOMPI_EXACT_FEE_POLICY,
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
export {
  VaultTreasuryFundingProvider,
  type VaultTreasuryFundingProviderOptions,
} from "./vault-treasury-funding-provider.js";
