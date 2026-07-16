import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  readKaspaSettlementExtension,
  sha256Hex,
  stableStringify,
  type BatchPaymentRequirements,
  type ExactPaymentRequirements,
  type ExactProfile,
  type Hash32Hex,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type PaymentScheme,
  type SompiString,
} from "@kaspa-x402/core";
import type {
  AddressCodec,
  ClaimTransactionBuilder,
  ClaimExecutionResult,
  ClaimPreview,
  ClaimRecoveryInput,
  DirectModeServer,
  DirectModeServerConfig,
  ExactTransactionVerifier,
  PaymentIdentifierRecord,
  ServerChainProvider,
  ServerResponse,
  ServerStateStore,
  SettlementCommit,
  VoucherVerifier,
} from "@kaspa-x402/server";

import {
  KASPA_TESTNET_NETWORK,
  KAS_ASSET,
  SOMPI_MERCHANT_CHECKOUT_PROFILE,
  issueCheckoutReceipt,
  issueMerchantCheckout,
  issuePaymentReceipt,
  verifyClosedCheckoutMandate,
  verifyClosedPaymentMandate,
  verifyCheckoutReceipt,
  verifyHumanPresentMandates,
  verifyMerchantCheckout,
  verifyPaymentReceipt,
  type Ap2PublicKeyResolver,
  type Ap2SigningIdentity,
  type MerchantCheckoutClaims,
  type VerifiedAp2Receipt,
  type VerifiedHumanPresentMandates,
  type VerifiedMerchantCheckout,
} from "../adapters/ap2/index.js";
import {
  AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
  type Ap2CommerceAuthorizationAcceptance,
  type Ap2CommerceAuthorizationPresentation,
  type Ap2CommerceAuthorizationStageAcceptance,
  encodeStageAcceptance,
} from "../adapters/ap2/commerce-authorization-module.js";
import {
  SOMPI_CHECKOUT_RECEIPT_HEADER as CHECKOUT_RECEIPT_HEADER,
  SOMPI_PAYMENT_RECEIPT_HEADER as PAYMENT_RECEIPT_HEADER,
} from "../adapters/ap2/paid-response-verifier.js";
import {
  assertPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "../purchase/identity.js";
import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import { SUPPORTED_PROTOCOL_PROFILES } from "../protocols/profiles.js";
import type {
  DemoCheckoutAuthorizationRecord,
  DemoCommerceAuthorizationStore,
  DemoPaymentAuthorizationRecord,
} from "./commerce-authorization-store.js";

export const DEMO_NETWORK = KASPA_TESTNET_NETWORK;

const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
const SOMPI_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_SOMPI_PATTERN = /^[1-9][0-9]*$/;
const PAYMENT_IDENTIFIER_PATTERN = /^pay_[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const MAX_HEADER_BYTES = 256 * 1024;
const X402_VERSION = SUPPORTED_PROTOCOL_PROFILES.x402.version;
const X402_SCHEME = SUPPORTED_PROTOCOL_PROFILES.x402.scheme;

export interface DemoResource {
  readonly identity: string;
  readonly url: string;
  readonly method: "GET";
  readonly mediaType: string;
  readonly body: Uint8Array;
}

export interface DemoMerchantOffer {
  readonly purchaseId: PurchaseId;
  readonly checkout: VerifiedMerchantCheckout;
  readonly paymentRequired: ServerResponse;
  readonly paymentRequirementsDigest: Sha256Digest;
}

export interface DemoMerchantOfferArtifacts {
  readonly purchaseId: PurchaseId;
  readonly merchantCheckout: string;
  readonly paymentRequiredHeader: string;
  readonly issuedAtSec: number;
}

export interface DemoMerchantPaidRequest {
  readonly purchaseId: PurchaseId;
  readonly merchantCheckout: string;
  /** Exact standard PAYMENT-REQUIRED value originally bound into the Checkout. */
  readonly paymentRequiredHeader: string;
  readonly paymentIdentifier: string;
  readonly headers: Record<string, string>;
}

interface DemoMerchantEvidenceJoinsCommon {
  readonly purchaseId: PurchaseId;
  readonly requestFingerprint: Sha256Digest;
  readonly merchantCheckoutDigest: Sha256Digest;
  readonly paymentRequirementsDigest: Sha256Digest;
  readonly checkoutMandateDigest: Sha256Digest;
  readonly checkoutMandateReference: string;
  readonly paymentMandateDigest: Sha256Digest;
  readonly paymentMandateReference: string;
  readonly paymentIdentifier: string;
  readonly x402PaymentRequirementsHash: Hash32Hex;
  readonly x402PaymentPayloadHash: Hash32Hex;
  readonly networkConfirmationId: Hash32Hex;
  readonly executionProfile: string;
  readonly maximumAuthorizedChargeAtomic: SompiString;
  readonly actualChargeAtomic: SompiString;
  readonly settlementDigest: Sha256Digest;
  readonly resourceDigest: Sha256Digest;
  readonly checkoutReceiptDigest: Sha256Digest;
  readonly paymentReceiptDigest: Sha256Digest;
}

export type DemoMerchantEvidenceJoins = DemoMerchantEvidenceJoinsCommon & (
  | Readonly<{
    paymentScheme: "exact";
    transactionId: Hash32Hex;
    paymentOutputIndex: number;
    commitmentId?: never;
    channelId?: never;
  }>
  | Readonly<{
    paymentScheme: "batch-settlement";
    commitmentId: Hash32Hex;
    channelId: Hash32Hex;
    transactionId?: never;
    paymentOutputIndex?: never;
  }>
);

export interface DemoMerchantPaidResult {
  readonly response: ServerResponse;
  readonly resource?: Readonly<{
    body: Uint8Array;
    digest: Sha256Digest;
    mediaType: string;
  }>;
  readonly settlement?: PaymentIdentifierRecord["settlement"];
  readonly ap2Receipts?: Readonly<{
    checkout: VerifiedAp2Receipt;
    payment: VerifiedAp2Receipt;
  }>;
  readonly evidence?: DemoMerchantEvidenceJoins;
}

export interface DemoMerchantFixtureConfig {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantOrigin: string;
  readonly merchantWebsite: string;
  readonly payTo: string;
  readonly amountAtomic: SompiString;
  readonly additionalCostCeilingAtomic: SompiString;
  readonly checkoutTtlMs: number;
  readonly authorityAudience: string;
  readonly expectedAuthorityIssuer: string;
  readonly expectedInstrumentId: string;
  readonly resource: DemoResource;
  readonly store: ServerStateStore;
  readonly authorizationStore: DemoCommerceAuthorizationStore;
  readonly addressCodec: AddressCodec;
  readonly chainProvider: ServerChainProvider;
  readonly voucherVerifier: VoucherVerifier;
  readonly paymentScheme: PaymentScheme;
  readonly exactTransactionVerifier?: ExactTransactionVerifier;
  readonly exactProfile?: ExactProfile;
  readonly batchMinDepositSompi?: SompiString;
  readonly batchRefundTimeoutDaa?: SompiString;
  readonly batchChargeAtomic?: SompiString;
  readonly claimBuilder?: ClaimTransactionBuilder;
  readonly serverPublicKey: string;
  readonly merchantCheckoutSigner: Ap2SigningIdentity;
  readonly merchantReceiptSigner: Ap2SigningIdentity;
  readonly paymentReceiptSigner: Ap2SigningIdentity;
  readonly ap2Trust: Ap2PublicKeyResolver;
  /** Merchant-owned durable proof that this exact paid request began before expiry. */
  readonly paidRequestContinuation?: Readonly<{
    authorizationPresentedAtSec(input: Readonly<{
      purchaseId: PurchaseId;
      paymentIdentifier: string;
      merchantCheckout: string;
      paymentRequiredHeader: string;
      paymentSignature: string;
    }>): number | undefined;
  }>;
  readonly now?: () => number;
}

interface BatchReceiptContext {
  readonly issuePaymentReceipt: (commitmentId: Hash32Hex) => Promise<string>;
  paymentReceiptArtifact?: string;
}

type PaymentEvidence = Readonly<{
  scheme: "exact";
  executionProfile: string;
  networkConfirmationId: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  paymentPayloadHash: Hash32Hex;
  transactionId: Hash32Hex;
  paymentOutputIndex: number;
  actualChargeAtomic: SompiString;
}> | Readonly<{
  scheme: "batch-settlement";
  executionProfile: string;
  networkConfirmationId: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  paymentPayloadHash: Hash32Hex;
  commitmentId: Hash32Hex;
  channelId: Hash32Hex;
  actualChargeAtomic: SompiString;
}>;

export class DemoMerchantError extends Error {
  readonly code:
    | "invalid_configuration"
    | "invalid_checkout"
    | "invalid_authorization"
    | "payment_mismatch"
    | "receipt_failure";

  constructor(code: DemoMerchantError["code"]) {
    const messages = {
      invalid_configuration: "demo Merchant configuration is invalid",
      invalid_checkout: "demo Merchant Checkout is invalid",
      invalid_authorization: "demo Merchant AP2 authorization is invalid",
      payment_mismatch: "demo Merchant payment does not match the authorized Checkout",
      receipt_failure: "demo Merchant AP2 Receipt processing failed",
    } as const;
    super(messages[code]);
    this.name = "DemoMerchantError";
    this.code = code;
  }
}

export class DemoMerchantFixture {
  private readonly now: () => number;
  private readonly resourceBytes: Uint8Array;
  private readonly resourceDigest: Sha256Digest;
  private readonly resourceFingerprint: Sha256Digest;
  private readonly batchReceiptContext: AsyncLocalStorage<BatchReceiptContext>;

  private constructor(
    private readonly config: DemoMerchantFixtureConfig,
    private readonly server: DirectModeServer,
    batchReceiptContext: AsyncLocalStorage<BatchReceiptContext>
  ) {
    validateConfiguration(config);
    this.now = config.now ?? Date.now;
    timestamp(this.now);
    this.resourceBytes = Uint8Array.from(config.resource.body);
    this.resourceDigest = evidenceDigest(this.resourceBytes);
    this.resourceFingerprint = requestFingerprint({
      url: config.resource.url,
      method: config.resource.method,
    });
    this.batchReceiptContext = batchReceiptContext;
  }

  static async create(config: DemoMerchantFixtureConfig): Promise<DemoMerchantFixture> {
    validateConfiguration(config);
    let module: typeof import("@kaspa-x402/server");
    try {
      module = await import("@kaspa-x402/server");
    } catch {
      throw new DemoMerchantError("invalid_configuration");
    }
    const batchReceiptContext = new AsyncLocalStorage<BatchReceiptContext>();
    const serverConfig: DirectModeServerConfig = {
      network: DEMO_NETWORK,
      asset: KAS_ASSET,
      payTo: config.payTo,
      serverPublicKey: config.serverPublicKey,
      minDepositSompi: config.batchMinDepositSompi ?? "1",
      amount: config.amountAtomic,
      refundTimeoutDaa: config.batchRefundTimeoutDaa ?? "1",
      maxTimeoutSeconds: 60,
      store: receiptEnrichingStore(config.store, batchReceiptContext),
      chainProvider: config.chainProvider,
      addressCodec: config.addressCodec,
      voucherVerifier: config.voucherVerifier,
      ...(config.exactTransactionVerifier
        ? { exactTransactionVerifier: config.exactTransactionVerifier }
        : {}),
      exactProfile: config.exactProfile ?? "standard-native",
      ...(config.claimBuilder ? { claimBuilder: config.claimBuilder } : {}),
      requirePaymentIdentifier: true,
      allowMainnet: false,
      acceptedFinality: "accepted",
    };
    return new DemoMerchantFixture(
      config,
      new module.DirectModeServer(serverConfig),
      batchReceiptContext
    );
  }

  async offer(purchaseIdValue: PurchaseId): Promise<DemoMerchantOffer> {
    const purchaseId = exactPurchaseId(purchaseIdValue, "invalid_checkout");
    const requestHash = requestHashHex(this.resourceFingerprint);

    // PAYMENT-REQUIRED must exist first because the Checkout signs its exact bytes.
    const paymentRequired = await this.server.handlePaidRequest(
      this.serverRequest({}, requestHash),
      () => {
        throw new DemoMerchantError("payment_mismatch");
      }
    );
    const paymentRequiredHeader = requireHeader(
      paymentRequired.headers,
      PAYMENT_REQUIRED_HEADER,
      "invalid_configuration"
    );
    const parsed = canonicalPaymentRequired(paymentRequiredHeader, "invalid_configuration");
    assertPaymentRequired(parsed, this.config, this.resourceFingerprint);
    if (paymentRequired.status !== 402) {
      throw new DemoMerchantError("invalid_configuration");
    }
    const paymentRequirementsDigest = evidenceDigest(
      Buffer.from(paymentRequiredHeader, "utf8")
    );
    const nowSec = clockSeconds(this.now);
    const expiresAtSec = nowSec + Math.ceil(this.config.checkoutTtlMs / 1000);
    const claims: MerchantCheckoutClaims = {
      profile: SOMPI_MERCHANT_CHECKOUT_PROFILE,
      iss: this.config.merchantCheckoutSigner.issuer,
      aud: this.config.authorityAudience,
      kid: this.config.merchantCheckoutSigner.kid,
      jti: `checkout:${purchaseId}:${paymentRequirementsDigest.slice("sha256:".length)}`,
      iat: nowSec,
      exp: expiresAtSec,
      nonce: randomBytes(32).toString("base64url"),
      purchase_id: purchaseId,
      merchant: {
        id: this.config.merchantId,
        name: this.config.merchantName,
        website: this.config.merchantWebsite,
        origin: this.config.merchantOrigin,
      },
      resource: {
        url: this.config.resource.url,
        method: this.config.resource.method,
        request_fingerprint: this.resourceFingerprint,
      },
      price: {
        amount_atomic: this.config.amountAtomic,
        asset: KAS_ASSET,
        network: DEMO_NETWORK,
        pay_to: this.config.payTo,
      },
      payment_requirements: {
        digest: paymentRequirementsDigest,
      },
      treasury: {
        mode: "separately-reserved",
        additional_cost_ceiling_atomic: this.config.additionalCostCeilingAtomic,
      },
      fulfilment: {
        identity: this.config.resource.identity,
        expected_digest: this.resourceDigest,
      },
    };

    let checkout: VerifiedMerchantCheckout;
    try {
      const artifact = await issueMerchantCheckout(
        claims,
        this.config.merchantCheckoutSigner,
        { nowSec, clockSkewSec: 0 }
      );
      checkout = await verifyMerchantCheckout(artifact, {
        trust: this.config.ap2Trust,
        expectedIssuer: this.config.merchantCheckoutSigner.issuer,
        expectedAudience: this.config.authorityAudience,
        expectedPurchaseId: purchaseId,
        expectedResourceFingerprint: this.resourceFingerprint,
        expectedPaymentRequirementsDigest: paymentRequirementsDigest,
        nowSec,
        clockSkewSec: 0,
      });
    } catch {
      throw new DemoMerchantError("invalid_configuration");
    }
    assertCheckoutMatchesConfiguration(
      checkout,
      this.config,
      this.resourceFingerprint,
      this.resourceDigest
    );
    return Object.freeze({
      purchaseId,
      checkout,
      paymentRequired,
      paymentRequirementsDigest,
    });
  }

  /** Rehydrate exact previously-issued offer bytes without minting replacement terms. */
  async restoreOffer(input: DemoMerchantOfferArtifacts): Promise<DemoMerchantOffer> {
    const purchaseId = exactPurchaseId(input?.purchaseId, "invalid_checkout");
    if (!Number.isSafeInteger(input?.issuedAtSec) || input.issuedAtSec <= 0) {
      throw new DemoMerchantError("invalid_checkout");
    }
    const paymentRequiredHeader = requireHeader(
      { [PAYMENT_REQUIRED_HEADER]: input?.paymentRequiredHeader },
      PAYMENT_REQUIRED_HEADER,
      "invalid_checkout"
    );
    const paymentRequiredValue = canonicalPaymentRequired(
      paymentRequiredHeader,
      "invalid_checkout"
    );
    assertPaymentRequired(paymentRequiredValue, this.config, this.resourceFingerprint);
    const paymentRequirementsDigest = evidenceDigest(
      Buffer.from(paymentRequiredHeader, "utf8")
    );
    let checkout: VerifiedMerchantCheckout;
    try {
      checkout = await verifyMerchantCheckout(input.merchantCheckout, {
        trust: this.config.ap2Trust,
        expectedIssuer: this.config.merchantCheckoutSigner.issuer,
        expectedAudience: this.config.authorityAudience,
        expectedPurchaseId: purchaseId,
        expectedResourceFingerprint: this.resourceFingerprint,
        expectedPaymentRequirementsDigest: paymentRequirementsDigest,
        nowSec: input.issuedAtSec,
        clockSkewSec: 0,
      });
    } catch {
      throw new DemoMerchantError("invalid_checkout");
    }
    if (checkout.issuedAtSec !== input.issuedAtSec) {
      throw new DemoMerchantError("invalid_checkout");
    }
    assertCheckoutMatchesConfiguration(
      checkout,
      this.config,
      this.resourceFingerprint,
      this.resourceDigest
    );
    return Object.freeze({
      purchaseId,
      checkout,
      paymentRequired: Object.freeze({
        status: 402,
        headers: Object.freeze({ [PAYMENT_REQUIRED_HEADER]: paymentRequiredHeader }),
      }),
      paymentRequirementsDigest,
    });
  }

  /** Shopping-Agent stage: verifies and durably accepts the Checkout Mandate. */
  async presentCheckoutMandate(
    input: Ap2CommerceAuthorizationPresentation
  ): Promise<Ap2CommerceAuthorizationStageAcceptance> {
    if (input.stage !== "checkout") throw new DemoMerchantError("invalid_authorization");
    const purchaseId = exactPurchaseId(input.purchaseId as PurchaseId, "invalid_authorization");
    const paymentIdentifier = requirePaymentIdentifier(input.paymentIdentifier);
    const checkoutArtifact = checkoutArtifactFromMandate(input.mandate);
    const nowSec = clockSeconds(this.now);
    let checkout: VerifiedMerchantCheckout;
    try {
      checkout = await verifyMerchantCheckout(checkoutArtifact, {
        trust: this.config.ap2Trust,
        expectedIssuer: this.config.merchantCheckoutSigner.issuer,
        expectedAudience: this.config.authorityAudience,
        expectedPurchaseId: purchaseId,
        expectedResourceFingerprint: this.resourceFingerprint,
        nowSec,
        clockSkewSec: 0,
      });
      if (
        checkout.checkoutDigest !== input.checkoutDigest ||
        input.mandateDigest !== evidenceDigest(input.mandate)
      ) {
        throw new Error("binding mismatch");
      }
      const mandate = await verifyClosedCheckoutMandate(input.mandate, {
        trust: this.config.ap2Trust,
        expectedAuthorityIssuer: this.config.expectedAuthorityIssuer,
        checkout,
        nowSec,
        clockSkewSec: 0,
      });
      const stored = this.config.authorizationStore.saveCheckout({
        purchaseId,
        checkoutDigest: checkout.checkoutDigest,
        authorizationEvidenceDigest: input.authorizationEvidenceDigest,
        checkoutArtifact,
        mandateArtifact: mandate.artifact,
        mandateDigest: input.mandateDigest,
        mandateReference: mandate.issuerJwtReference,
      });
      return stageAcceptance("checkout", stored, paymentIdentifier);
    } catch (error) {
      if (error instanceof DemoMerchantError) throw error;
      throw new DemoMerchantError("invalid_authorization");
    }
  }

  /** Credential/payment-verifier stage: accepts Payment Mandate only after Checkout. */
  async presentPaymentMandate(
    input: Ap2CommerceAuthorizationPresentation
  ): Promise<Ap2CommerceAuthorizationStageAcceptance> {
    if (input.stage !== "payment") throw new DemoMerchantError("invalid_authorization");
    const purchaseId = exactPurchaseId(input.purchaseId as PurchaseId, "invalid_authorization");
    const paymentIdentifier = requirePaymentIdentifier(input.paymentIdentifier);
    const checkoutRecord = this.config.authorizationStore.loadCheckout(purchaseId);
    if (
      !checkoutRecord ||
      checkoutRecord.checkoutDigest !== input.checkoutDigest ||
      checkoutRecord.authorizationEvidenceDigest !== input.authorizationEvidenceDigest ||
      input.mandateDigest !== evidenceDigest(input.mandate)
    ) {
      throw new DemoMerchantError("invalid_authorization");
    }
    const nowSec = clockSeconds(this.now);
    try {
      const checkout = await verifyMerchantCheckout(checkoutRecord.checkoutArtifact, {
        trust: this.config.ap2Trust,
        expectedIssuer: this.config.merchantCheckoutSigner.issuer,
        expectedAudience: this.config.authorityAudience,
        expectedPurchaseId: purchaseId,
        expectedResourceFingerprint: this.resourceFingerprint,
        nowSec,
        clockSkewSec: 0,
      });
      await verifyClosedPaymentMandate(input.mandate, {
        trust: this.config.ap2Trust,
        expectedAuthorityIssuer: this.config.expectedAuthorityIssuer,
        checkout,
        expectedInstrumentId: this.config.expectedInstrumentId,
        nowSec,
        clockSkewSec: 0,
      });
      // Pair verification additionally proves one exact authority ceremony.
      const mandates = await verifyHumanPresentMandates({
        checkoutMandate: checkoutRecord.mandateArtifact,
        paymentMandate: input.mandate,
      }, {
        trust: this.config.ap2Trust,
        expectedAuthorityIssuer: this.config.expectedAuthorityIssuer,
        checkout,
        expectedInstrumentId: this.config.expectedInstrumentId,
        nowSec,
        clockSkewSec: 0,
      });
      const stored = this.config.authorizationStore.savePayment({
        purchaseId,
        paymentIdentifier,
        checkoutDigest: checkout.checkoutDigest,
        authorizationEvidenceDigest: input.authorizationEvidenceDigest,
        mandateArtifact: mandates.payment.artifact,
        mandateDigest: input.mandateDigest,
        mandateReference: mandates.payment.issuerJwtReference,
      });
      return stageAcceptance("payment", stored, paymentIdentifier);
    } catch (error) {
      if (error instanceof DemoMerchantError) throw error;
      throw new DemoMerchantError("invalid_authorization");
    }
  }

  async commerceAuthorizationStatus(input: {
    purchaseId: PurchaseId;
    paymentIdentifier: string;
    checkoutDigest: Sha256Digest;
  }): Promise<Ap2CommerceAuthorizationAcceptance | undefined> {
    const purchaseId = exactPurchaseId(input.purchaseId, "invalid_authorization");
    const paymentIdentifier = requirePaymentIdentifier(input.paymentIdentifier);
    const checkout = this.config.authorizationStore.loadCheckout(purchaseId);
    const payment = this.config.authorizationStore.loadPayment(paymentIdentifier);
    if (!checkout || !payment) return undefined;
    if (
      checkout.checkoutDigest !== input.checkoutDigest ||
      payment.purchaseId !== purchaseId ||
      payment.checkoutDigest !== checkout.checkoutDigest ||
      payment.authorizationEvidenceDigest !== checkout.authorizationEvidenceDigest
    ) {
      throw new DemoMerchantError("invalid_authorization");
    }
    const checkoutAcceptance = stageAcceptance("checkout", checkout, paymentIdentifier);
    const paymentAcceptance = stageAcceptance("payment", payment, paymentIdentifier);
    return Object.freeze({
      profile: AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
      version: 1,
      status: "accepted",
      purchaseId,
      paymentIdentifier,
      checkoutDigest: checkout.checkoutDigest,
      authorizationEvidenceDigest: checkout.authorizationEvidenceDigest,
      checkoutMandateDigest: checkout.mandateDigest,
      paymentMandateDigest: payment.mandateDigest,
      checkoutAcceptanceDigest: evidenceDigest(encodeStageAcceptance(checkoutAcceptance)),
      paymentAcceptanceDigest: evidenceDigest(encodeStageAcceptance(paymentAcceptance)),
    });
  }

  async listClaimableBatchChannels() {
    this.assertBatchMerchant();
    return this.server.listClaimableChannels();
  }

  async previewBatchClaim(channelId: Hash32Hex): Promise<ClaimPreview> {
    this.assertBatchMerchant();
    return this.server.previewClaim(channelId);
  }

  async executeBatchClaim(channelId: Hash32Hex): Promise<ClaimExecutionResult> {
    this.assertBatchMerchant();
    return this.server.executeClaim(channelId);
  }

  async recoverBatchClaim(
    channelId: Hash32Hex,
    input?: ClaimRecoveryInput
  ): Promise<ClaimExecutionResult> {
    this.assertBatchMerchant();
    return this.server.recoverAcceptedClaim(channelId, input);
  }

  async abandonBatchClaim(channelId: Hash32Hex, reason?: string): Promise<void> {
    this.assertBatchMerchant();
    await this.server.abandonClaimAttempt(channelId, reason);
  }

  async handlePaid(request: DemoMerchantPaidRequest): Promise<DemoMerchantPaidResult> {
    const purchaseId = exactPurchaseId(request?.purchaseId, "invalid_checkout");
    const paymentIdentifier = requirePaymentIdentifier(request?.paymentIdentifier);
    const paymentRequired = canonicalPaymentRequired(
      request?.paymentRequiredHeader,
      "invalid_checkout"
    );
    const paymentRequirementsDigest = evidenceDigest(
      Buffer.from(request.paymentRequiredHeader, "utf8")
    );
    assertPaymentRequired(paymentRequired, this.config, this.resourceFingerprint);

    const nowSec = clockSeconds(this.now);
    const paymentSignature = requireHeader(
      request?.headers,
      PAYMENT_SIGNATURE_HEADER,
      "payment_mismatch"
    );
    let authorizationNowSec = nowSec;
    try {
      const continuation = this.config.paidRequestContinuation?.authorizationPresentedAtSec({
        purchaseId,
        paymentIdentifier,
        merchantCheckout: request.merchantCheckout,
        paymentRequiredHeader: request.paymentRequiredHeader,
        paymentSignature,
      });
      if (continuation !== undefined) {
        if (!Number.isSafeInteger(continuation) || continuation <= 0 || continuation > nowSec) {
          throw new Error("invalid continuation time");
        }
        authorizationNowSec = continuation;
      }
    } catch {
      throw new DemoMerchantError("invalid_authorization");
    }
    let checkout: VerifiedMerchantCheckout;
    try {
      checkout = await verifyMerchantCheckout(request?.merchantCheckout, {
        trust: this.config.ap2Trust,
        expectedIssuer: this.config.merchantCheckoutSigner.issuer,
        expectedAudience: this.config.authorityAudience,
        expectedPurchaseId: purchaseId,
        expectedResourceFingerprint: this.resourceFingerprint,
        expectedPaymentRequirementsDigest: paymentRequirementsDigest,
        nowSec: authorizationNowSec,
        clockSkewSec: 0,
      });
    } catch {
      throw new DemoMerchantError("invalid_checkout");
    }
    assertCheckoutMatchesConfiguration(
      checkout,
      this.config,
      this.resourceFingerprint,
      this.resourceDigest
    );

    const mandates = await this.authorizedMandates(
      purchaseId,
      paymentIdentifier,
      checkout,
      authorizationNowSec
    );
    const requestHash = requestHashHex(this.resourceFingerprint);
    const paymentPayload = assertPaymentSignatureJoins(
      request?.headers,
      paymentRequired.accepts[0],
      requestHash,
      paymentIdentifier
    );
    let handlerFailure: DemoMerchantError | undefined;
    const receiptContext: BatchReceiptContext = {
      issuePaymentReceipt: (commitmentId) => this.issuePaymentReceipt(
        mandates,
        paymentIdentifier,
        commitmentId,
        nowSec
      ),
    };
    const response = await this.batchReceiptContext.run(receiptContext, () =>
      this.server.handlePaidRequest(
        this.serverRequest(request.headers, requestHash),
        async ({ payment, requestFingerprint: paidFingerprint, paymentIdentifier: paidId }) => {
          try {
            if (
              payment.scheme !== this.config.paymentScheme ||
              paidId !== paymentIdentifier ||
              paidFingerprint !== requestHash ||
              stableStringify(payment.accepted) !== stableStringify(paymentRequired.accepts[0]) ||
              payment.accepted.network !== checkout.terms.network ||
              payment.accepted.amount !== checkout.terms.amountAtomic ||
              payment.accepted.payTo !== checkout.terms.payTo ||
              (payment.scheme === "exact" && payment.finality !== "accepted")
            ) {
              throw new DemoMerchantError("payment_mismatch");
            }
            const checkoutReceipt = await this.issueCheckoutReceipt(
              mandates,
              purchaseId,
              nowSec
            );
            const paymentReceipt = payment.scheme === "exact"
              ? await this.issuePaymentReceipt(
                  mandates,
                  paymentIdentifier,
                  payment.transactionId,
                  nowSec
                )
              : undefined;
            return {
              status: 200,
              headers: {
                "content-type": this.config.resource.mediaType,
                [CHECKOUT_RECEIPT_HEADER]: checkoutReceipt,
                ...(paymentReceipt ? { [PAYMENT_RECEIPT_HEADER]: paymentReceipt } : {}),
              },
              body: Buffer.from(this.resourceBytes).toString("base64url"),
              chargedAmount: this.config.paymentScheme === "batch-settlement"
                ? this.config.batchChargeAtomic
                : checkout.terms.amountAtomic,
            };
          } catch (error) {
            handlerFailure = error instanceof DemoMerchantError
              ? error
              : new DemoMerchantError("receipt_failure");
            throw handlerFailure;
          }
        }
      )
    );
    if (handlerFailure) throw handlerFailure;
    if (response.status < 200 || response.status >= 300) {
      return Object.freeze({ response });
    }
    if (!paymentPayload) {
      // A successful response cannot follow an absent or malformed payment header.
      throw new DemoMerchantError("payment_mismatch");
    }

    const payment = await this.config.store.loadPaymentIdentifier(paymentIdentifier);
    if (!payment) throw new DemoMerchantError("payment_mismatch");
    const paymentEvidence = await this.paymentEvidence({
      payment,
      response,
      checkout,
      paymentIdentifier,
      requestHash,
      paymentRequirement: paymentRequired.accepts[0],
      paymentPayload,
      resourceBody: this.resourceBytes,
    });

    const checkoutReceiptArtifact = requireHeader(
      response.headers,
      CHECKOUT_RECEIPT_HEADER,
      "receipt_failure"
    );
    const paymentReceiptArtifact = requireHeader(
      response.headers,
      PAYMENT_RECEIPT_HEADER,
      "receipt_failure"
    );
    let checkoutReceipt: VerifiedAp2Receipt;
    let paymentReceipt: VerifiedAp2Receipt;
    try {
      [checkoutReceipt, paymentReceipt] = await Promise.all([
        verifyCheckoutReceipt(checkoutReceiptArtifact, {
          trust: this.config.ap2Trust,
          expectedIssuer: this.config.merchantReceiptSigner.issuer,
          mandate: mandates.checkout,
          nowSec,
          clockSkewSec: 0,
        }),
        verifyPaymentReceipt(paymentReceiptArtifact, {
          trust: this.config.ap2Trust,
          expectedIssuer: this.config.paymentReceiptSigner.issuer,
          mandate: mandates.payment,
          expectedPaymentId: paymentIdentifier,
          nowSec,
          clockSkewSec: 0,
        }),
      ]);
    } catch {
      throw new DemoMerchantError("receipt_failure");
    }
    if (
      checkoutReceipt.status !== "Success" ||
      checkoutReceipt.orderId !== purchaseId ||
      paymentReceipt.status !== "Success" ||
      paymentReceipt.paymentId !== paymentIdentifier ||
      paymentReceipt.pspConfirmationId !== paymentIdentifier ||
      paymentReceipt.networkConfirmationId !== paymentEvidence.networkConfirmationId
    ) {
      throw new DemoMerchantError("receipt_failure");
    }

    const evidence = Object.freeze({
      purchaseId,
      requestFingerprint: this.resourceFingerprint,
      merchantCheckoutDigest: checkout.checkoutDigest,
      paymentRequirementsDigest,
      checkoutMandateDigest: evidenceDigest(mandates.checkout.artifact),
      checkoutMandateReference: mandates.checkout.issuerJwtReference,
      paymentMandateDigest: evidenceDigest(mandates.payment.artifact),
      paymentMandateReference: mandates.payment.issuerJwtReference,
      paymentIdentifier,
      x402PaymentRequirementsHash: paymentEvidence.paymentRequirementsHash,
      x402PaymentPayloadHash: paymentEvidence.paymentPayloadHash,
      networkConfirmationId: paymentEvidence.networkConfirmationId,
      executionProfile: paymentEvidence.executionProfile,
      maximumAuthorizedChargeAtomic: checkout.terms.amountAtomic,
      actualChargeAtomic: paymentEvidence.actualChargeAtomic,
      ...(paymentEvidence.scheme === "exact"
        ? {
            paymentScheme: "exact" as const,
            transactionId: paymentEvidence.transactionId,
            paymentOutputIndex: paymentEvidence.paymentOutputIndex,
          }
        : {
            paymentScheme: "batch-settlement" as const,
            commitmentId: paymentEvidence.commitmentId,
            channelId: paymentEvidence.channelId,
          }),
      settlementDigest: evidenceDigest(stableStringify(payment.settlement)),
      resourceDigest: this.resourceDigest,
      checkoutReceiptDigest: evidenceDigest(checkoutReceiptArtifact),
      paymentReceiptDigest: evidenceDigest(paymentReceiptArtifact),
    } satisfies DemoMerchantEvidenceJoins);
    return Object.freeze({
      response,
      resource: Object.freeze({
        body: Uint8Array.from(this.resourceBytes),
        digest: this.resourceDigest,
        mediaType: this.config.resource.mediaType,
      }),
      settlement: payment.settlement,
      ap2Receipts: Object.freeze({ checkout: checkoutReceipt, payment: paymentReceipt }),
      evidence,
    });
  }

  private async authorizedMandates(
    purchaseId: PurchaseId,
    paymentIdentifier: string,
    checkout: VerifiedMerchantCheckout,
    nowSec: number
  ): Promise<VerifiedHumanPresentMandates> {
    const checkoutAuthorization = this.config.authorizationStore.loadCheckout(purchaseId);
    const paymentAuthorization = this.config.authorizationStore.loadPayment(paymentIdentifier);
    if (
      !checkoutAuthorization ||
      !paymentAuthorization ||
      checkoutAuthorization.checkoutDigest !== checkout.checkoutDigest ||
      checkoutAuthorization.checkoutArtifact !== checkout.artifact ||
      paymentAuthorization.purchaseId !== purchaseId ||
      paymentAuthorization.checkoutDigest !== checkout.checkoutDigest ||
      paymentAuthorization.authorizationEvidenceDigest !==
        checkoutAuthorization.authorizationEvidenceDigest
    ) {
      throw new DemoMerchantError("invalid_authorization");
    }
    try {
      return await verifyHumanPresentMandates({
        checkoutMandate: checkoutAuthorization.mandateArtifact,
        paymentMandate: paymentAuthorization.mandateArtifact,
      }, {
        trust: this.config.ap2Trust,
        expectedAuthorityIssuer: this.config.expectedAuthorityIssuer,
        checkout,
        expectedInstrumentId: this.config.expectedInstrumentId,
        nowSec,
        clockSkewSec: 0,
      });
    } catch {
      throw new DemoMerchantError("invalid_authorization");
    }
  }

  private assertBatchMerchant(): void {
    if (this.config.paymentScheme !== "batch-settlement" || !this.config.claimBuilder) {
      throw new DemoMerchantError("invalid_configuration");
    }
  }

  private async issueCheckoutReceipt(
    mandates: VerifiedHumanPresentMandates,
    purchaseId: PurchaseId,
    nowSec: number
  ): Promise<string> {
    try {
      return await issueCheckoutReceipt({
        status: "Success",
        mandate: mandates.checkout,
        orderId: purchaseId,
        issuedAtSec: nowSec,
      }, this.config.merchantReceiptSigner);
    } catch {
      throw new DemoMerchantError("receipt_failure");
    }
  }

  private async issuePaymentReceipt(
    mandates: VerifiedHumanPresentMandates,
    paymentIdentifier: string,
    networkConfirmationId: Hash32Hex,
    nowSec: number
  ): Promise<string> {
    try {
      return await issuePaymentReceipt({
        status: "Success",
        mandate: mandates.payment,
        paymentId: paymentIdentifier,
        pspConfirmationId: paymentIdentifier,
        networkConfirmationId,
        issuedAtSec: nowSec,
      }, this.config.paymentReceiptSigner);
    } catch {
      throw new DemoMerchantError("receipt_failure");
    }
  }

  private async paymentEvidence(input: {
    payment: PaymentIdentifierRecord;
    response: ServerResponse;
    checkout: VerifiedMerchantCheckout;
    paymentIdentifier: string;
    requestHash: Hash32Hex;
    paymentRequirement: PaymentRequirements;
    paymentPayload: PaymentPayload;
    resourceBody: Uint8Array;
  }): Promise<PaymentEvidence> {
    if (this.config.paymentScheme === "exact") {
      if (!input.payment.transactionId || input.paymentRequirement.scheme !== "exact") {
        throw new DemoMerchantError("payment_mismatch");
      }
      const exact = await this.config.store.loadExactPayment(input.payment.transactionId);
      if (!exact) throw new DemoMerchantError("payment_mismatch");
      assertExactPaymentJoinsCheckout({ ...input, paymentRequirement: input.paymentRequirement, exact });
      return Object.freeze({
        scheme: "exact",
        executionProfile: `kaspa-exact-v2:${exact.profile}`,
        networkConfirmationId: exact.transactionId,
        paymentRequirementsHash: exact.paymentRequirementsHash,
        paymentPayloadHash: exact.paymentPayloadHash,
        transactionId: exact.transactionId,
        paymentOutputIndex: exact.paymentOutputIndex,
        actualChargeAtomic: exact.amount,
      });
    }

    if (!input.payment.channelId || input.paymentRequirement.scheme !== "batch-settlement") {
      throw new DemoMerchantError("payment_mismatch");
    }
    const extension = readKaspaSettlementExtension(input.payment.settlement);
    if (
      !extension?.commitmentId ||
      extension.channelState?.channelId !== input.payment.channelId
    ) {
      throw new DemoMerchantError("payment_mismatch");
    }
    const commitment = await this.config.store.loadCommitment(extension.commitmentId);
    if (!commitment) throw new DemoMerchantError("payment_mismatch");
    assertBatchPaymentJoinsCheckout({
      ...input,
      paymentRequirement: input.paymentRequirement,
      commitment,
      expectedChargeAtomic: this.config.batchChargeAtomic!,
    });
    return Object.freeze({
      scheme: "batch-settlement",
      executionProfile: "kaspa-escrow-v1:batch-settlement",
      networkConfirmationId: commitment.commitmentId,
      paymentRequirementsHash: commitment.paymentRequirementsHash,
      paymentPayloadHash: input.payment.paymentPayloadHash,
      commitmentId: commitment.commitmentId,
      channelId: commitment.channelId,
      actualChargeAtomic: commitment.chargedAmount,
    });
  }

  private serverRequest(headers: Record<string, string>, requestHash: Hash32Hex) {
    return {
      method: this.config.resource.method,
      url: this.config.resource.url,
      headers,
      resource: {
        url: this.config.resource.url,
        description: this.config.merchantName,
        mimeType: this.config.resource.mediaType,
      },
      paymentAmount: this.config.amountAtomic,
      paymentScheme: this.config.paymentScheme,
      paymentSchemes: [this.config.paymentScheme],
      requestHash,
    };
  }
}

function assertPaymentRequired(
  required: PaymentRequired,
  config: DemoMerchantFixtureConfig,
  fingerprint: Sha256Digest
): void {
  const accepted = required.accepts[0];
  if (
    required.x402Version !== X402_VERSION ||
    required.accepts.length !== 1 ||
    !accepted ||
    accepted.scheme !== config.paymentScheme ||
    accepted.network !== DEMO_NETWORK ||
    accepted.asset !== KAS_ASSET ||
    accepted.amount !== config.amountAtomic ||
    accepted.payTo !== config.payTo ||
    required.resource.url !== config.resource.url ||
    (required.resource.mimeType !== undefined && required.resource.mimeType !== config.resource.mediaType) ||
    requestHashHex(fingerprint).length !== 64
  ) {
    throw new DemoMerchantError("invalid_checkout");
  }
  if (accepted.scheme === "exact") {
    if (
      X402_SCHEME !== "exact" ||
      accepted.extra.binding !== "kaspa-exact-v2" ||
      accepted.extra.profile !== (config.exactProfile ?? "standard-native") ||
      accepted.extra.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
      ((config.exactProfile ?? "standard-native") === "additive"
        ? accepted.extra.paymentOutputIndex !== 0
        : accepted.extra.paymentOutputIndex !== undefined)
    ) {
      throw new DemoMerchantError("invalid_checkout");
    }
    return;
  }
  if (
    accepted.extra.binding !== "kaspa-escrow-v1" ||
    accepted.extra.templateId !== "kaspa-x402-escrow-v1" ||
    accepted.extra.serverPublicKey !== config.serverPublicKey ||
    accepted.extra.minDepositSompi !== config.batchMinDepositSompi ||
    accepted.extra.refundTimeoutDaa !== config.batchRefundTimeoutDaa
  ) {
    throw new DemoMerchantError("invalid_checkout");
  }
}

function assertCheckoutMatchesConfiguration(
  checkout: VerifiedMerchantCheckout,
  config: DemoMerchantFixtureConfig,
  fingerprint: Sha256Digest,
  resourceDigest: Sha256Digest
): void {
  if (
    checkout.profile !== SOMPI_MERCHANT_CHECKOUT_PROFILE ||
    checkout.issuer !== config.merchantCheckoutSigner.issuer ||
    checkout.audience !== config.authorityAudience ||
    checkout.terms.merchant.id !== config.merchantId ||
    checkout.terms.merchant.name !== config.merchantName ||
    checkout.terms.merchant.origin !== config.merchantOrigin ||
    checkout.claims.merchant.website !== config.merchantWebsite ||
    checkout.resourceUrl !== config.resource.url ||
    checkout.method !== config.resource.method ||
    checkout.terms.resourceFingerprint !== fingerprint ||
    checkout.terms.amountAtomic !== config.amountAtomic ||
    checkout.terms.asset !== KAS_ASSET ||
    checkout.terms.network !== DEMO_NETWORK ||
    checkout.terms.payTo !== config.payTo ||
    checkout.additionalCostCeilingAtomic !== config.additionalCostCeilingAtomic ||
    checkout.fulfilment?.identity !== config.resource.identity ||
    checkout.fulfilment.expectedDigest !== resourceDigest ||
    checkout.checkoutDigest !== evidenceDigest(checkout.artifact)
  ) {
    throw new DemoMerchantError("invalid_checkout");
  }
}

function assertPaymentSignatureJoins(
  headers: Record<string, string>,
  accepted: PaymentRequirements,
  requestHash: Hash32Hex,
  paymentIdentifier: string
): PaymentPayload | undefined {
  const header = optionalHeader(headers, PAYMENT_SIGNATURE_HEADER, "payment_mismatch");
  if (header === undefined) return undefined;
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
    if (encodePaymentSignatureHeader(payload) !== header) {
      throw new Error("non-canonical PAYMENT-SIGNATURE");
    }
  } catch {
    return undefined;
  }
  const extensionKeys = Object.keys(payload.extensions ?? {});
  const paymentIdentifierInfo = payload.extensions?.["payment-identifier"]?.info;
  if (
    stableStringify(payload.accepted) !== stableStringify(accepted) ||
    payload.accepted.scheme !== accepted.scheme ||
    (accepted.scheme === "exact" && (
      payload.payload.type !== "exact-transaction" ||
      payload.payload.requestHash !== requestHash
    )) ||
    (accepted.scheme === "batch-settlement" &&
      payload.payload.type !== "deposit-voucher" &&
      payload.payload.type !== "voucher") ||
    extensionKeys.length !== 1 ||
    extensionKeys[0] !== "payment-identifier" ||
    paymentIdentifierInfo?.required !== true ||
    paymentIdentifierInfo.id !== paymentIdentifier
  ) {
    throw new DemoMerchantError("payment_mismatch");
  }
  return payload;
}

function assertExactPaymentJoinsCheckout(input: {
  payment: PaymentIdentifierRecord;
  exact: NonNullable<Awaited<ReturnType<ServerStateStore["loadExactPayment"]>>>;
  response: ServerResponse;
  checkout: VerifiedMerchantCheckout;
  paymentIdentifier: string;
  requestHash: Hash32Hex;
  paymentRequirement: ExactPaymentRequirements;
  paymentPayload: PaymentPayload;
  resourceBody: Uint8Array;
}): void {
  const {
    payment,
    exact,
    response,
    checkout,
    paymentIdentifier,
    requestHash,
    paymentRequirement,
    paymentPayload,
    resourceBody,
  } = input;
  let wireSettlement: unknown;
  const settlementHeader = requireHeader(
    response.headers,
    PAYMENT_RESPONSE_HEADER,
    "payment_mismatch"
  );
  try {
    wireSettlement = decodePaymentResponseHeader(settlementHeader);
    if (encodePaymentResponseHeader(wireSettlement as never) !== settlementHeader) {
      throw new Error("non-canonical PAYMENT-RESPONSE");
    }
  } catch {
    throw new DemoMerchantError("payment_mismatch");
  }
  const requirementHash = sha256Hex(stableStringify(paymentRequirement));
  const payloadHash = sha256Hex(stableStringify(paymentPayload));
  if (
    payment.id !== paymentIdentifier ||
    payment.fingerprint !== requestHash ||
    payment.paymentPayloadHash !== payloadHash ||
    payment.transactionId !== exact.transactionId ||
    payment.paymentOutputIndex !== exact.paymentOutputIndex ||
    payment.settlement.success !== true ||
    payment.settlement.transaction !== exact.transactionId ||
    payment.settlement.network !== checkout.terms.network ||
    payment.settlement.amount !== checkout.terms.amountAtomic ||
    exact.requestFingerprint !== requestHash ||
    exact.paymentRequirementsHash !== requirementHash ||
    exact.paymentPayloadHash !== payloadHash ||
    exact.amount !== checkout.terms.amountAtomic ||
    exact.finality !== "accepted" ||
    stableStringify(exact.response) !== stableStringify(response) ||
    stableStringify(payment.response) !== stableStringify(response) ||
    stableStringify(wireSettlement) !== stableStringify(payment.settlement) ||
    response.body !== Buffer.from(resourceBody).toString("base64url")
  ) {
    throw new DemoMerchantError("payment_mismatch");
  }
}

function assertBatchPaymentJoinsCheckout(input: {
  payment: PaymentIdentifierRecord;
  commitment: NonNullable<Awaited<ReturnType<ServerStateStore["loadCommitment"]>>>;
  response: ServerResponse;
  checkout: VerifiedMerchantCheckout;
  paymentIdentifier: string;
  requestHash: Hash32Hex;
  paymentRequirement: BatchPaymentRequirements;
  paymentPayload: PaymentPayload;
  resourceBody: Uint8Array;
  expectedChargeAtomic: SompiString;
}): void {
  const {
    payment,
    commitment,
    response,
    checkout,
    paymentIdentifier,
    requestHash,
    paymentRequirement,
    paymentPayload,
    resourceBody,
    expectedChargeAtomic,
  } = input;
  const wireSettlement = canonicalSettlement(response);
  const payloadHash = sha256Hex(stableStringify(paymentPayload));
  const extension = readKaspaSettlementExtension(payment.settlement);
  if (
    payment.id !== paymentIdentifier ||
    payment.fingerprint !== requestHash ||
    payment.paymentPayloadHash !== payloadHash ||
    payment.channelId !== commitment.channelId ||
    payment.transactionId !== undefined ||
    payment.paymentOutputIndex !== undefined ||
    payment.settlement.success !== true ||
    payment.settlement.transaction !== commitment.commitmentId ||
    payment.settlement.network !== checkout.terms.network ||
    payment.settlement.amount !== expectedChargeAtomic ||
    extension?.commitmentId !== commitment.commitmentId ||
    extension.channelState?.channelId !== commitment.channelId ||
    commitment.requestFingerprint !== requestHash ||
    commitment.paymentIdentifier !== paymentIdentifier ||
    commitment.chargedAmount !== expectedChargeAtomic ||
    stableStringify(commitment.response) !== stableStringify(response) ||
    stableStringify(payment.response) !== stableStringify(response) ||
    stableStringify(wireSettlement) !== stableStringify(payment.settlement) ||
    response.body !== Buffer.from(resourceBody).toString("base64url")
  ) {
    throw new DemoMerchantError("payment_mismatch");
  }
}

function canonicalSettlement(response: ServerResponse): unknown {
  const settlementHeader = requireHeader(
    response.headers,
    PAYMENT_RESPONSE_HEADER,
    "payment_mismatch"
  );
  try {
    const wireSettlement = decodePaymentResponseHeader(settlementHeader);
    if (encodePaymentResponseHeader(wireSettlement) !== settlementHeader) {
      throw new Error("non-canonical PAYMENT-RESPONSE");
    }
    return wireSettlement;
  } catch {
    throw new DemoMerchantError("payment_mismatch");
  }
}

function canonicalPaymentRequired(
  header: unknown,
  code: DemoMerchantError["code"]
): PaymentRequired {
  if (
    typeof header !== "string" ||
    header.length === 0 ||
    Buffer.byteLength(header, "utf8") > MAX_HEADER_BYTES ||
    /[^\x21-\x7e]/.test(header)
  ) {
    throw new DemoMerchantError(code);
  }
  try {
    const parsed = decodePaymentRequiredHeader(header);
    if (encodePaymentRequiredHeader(parsed) !== header) throw new Error("non-canonical header");
    return parsed;
  } catch {
    throw new DemoMerchantError(code);
  }
}

function requireHeader(
  headers: Record<string, string>,
  name: string,
  code: DemoMerchantError["code"]
): string {
  const value = optionalHeader(headers, name, code);
  if (value === undefined) throw new DemoMerchantError(code);
  return value;
}

function optionalHeader(
  headers: Record<string, string>,
  name: string,
  code: DemoMerchantError["code"]
): string | undefined {
  if (!isRecord(headers)) throw new DemoMerchantError(code);
  const matches = Object.entries(headers).filter(([key]) => key.toUpperCase() === name);
  if (matches.length > 1) throw new DemoMerchantError(code);
  const value = matches[0]?.[1];
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new DemoMerchantError(code);
  }
  return value;
}

function requestHashHex(value: Sha256Digest): Hash32Hex {
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new DemoMerchantError("invalid_configuration");
  }
  const bytes = Buffer.from(value.slice("sha256:".length), "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value.slice("sha256:".length)) {
    throw new DemoMerchantError("invalid_configuration");
  }
  return bytes.toString("hex");
}

function stageAcceptance(
  stage: "checkout" | "payment",
  record: DemoCheckoutAuthorizationRecord | DemoPaymentAuthorizationRecord,
  paymentIdentifier: string
): Ap2CommerceAuthorizationStageAcceptance {
  return Object.freeze({
    profile: AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
    version: 1,
    status: "accepted",
    stage,
    purchaseId: record.purchaseId,
    paymentIdentifier,
    checkoutDigest: record.checkoutDigest,
    mandateDigest: record.mandateDigest,
    acceptedAtMs: record.acceptedAtMs,
  });
}

function checkoutArtifactFromMandate(artifact: string): string {
  if (
    typeof artifact !== "string" ||
    artifact.length === 0 ||
    Buffer.byteLength(artifact, "ascii") > 64 * 1024 ||
    /[^\x21-\x7e]/.test(artifact)
  ) {
    throw new DemoMerchantError("invalid_authorization");
  }
  try {
    const disclosures = artifact.split("~").slice(1, -1);
    const matches = disclosures
      .map((encoded) => JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
      .filter(
        (value) =>
          Array.isArray(value) &&
          value.length === 3 &&
          value[1] === "checkout_jwt" &&
          typeof value[2] === "string"
      );
    if (matches.length !== 1) throw new Error("missing checkout disclosure");
    return matches[0][2] as string;
  } catch {
    throw new DemoMerchantError("invalid_authorization");
  }
}

function validateConfiguration(config: DemoMerchantFixtureConfig): void {
  if (
    !config ||
    !ID_PATTERN.test(config.merchantId) ||
    config.merchantName.length === 0 ||
    config.merchantName.length > 160 ||
    !isCanonicalOrigin(config.merchantOrigin) ||
    !isCanonicalUrl(config.merchantWebsite) ||
    new URL(config.merchantWebsite).origin !== config.merchantOrigin ||
    !isCanonicalUrl(config.resource?.url) ||
    new URL(config.resource.url).origin !== config.merchantOrigin ||
    !ID_PATTERN.test(config.resource.identity) ||
    config.resource.method !== "GET" ||
    config.resource.mediaType.length === 0 ||
    !(config.resource.body instanceof Uint8Array) ||
    config.resource.body.byteLength === 0 ||
    !POSITIVE_SOMPI_PATTERN.test(config.amountAtomic) ||
    BigInt(config.amountAtomic) > UINT64_MAX ||
    BigInt(config.amountAtomic) > BigInt(Number.MAX_SAFE_INTEGER) ||
    !SOMPI_PATTERN.test(config.additionalCostCeilingAtomic) ||
    BigInt(config.additionalCostCeilingAtomic) > UINT64_MAX ||
    !config.payTo.startsWith("kaspatest:") ||
    !Number.isSafeInteger(config.checkoutTtlMs) ||
    config.checkoutTtlMs <= 0 ||
    config.checkoutTtlMs > 5 * 60_000 ||
    !ID_PATTERN.test(config.authorityAudience) ||
    !ID_PATTERN.test(config.expectedAuthorityIssuer) ||
    !ID_PATTERN.test(config.expectedInstrumentId) ||
    !config.store ||
    !config.authorizationStore ||
    typeof config.authorizationStore.saveCheckout !== "function" ||
    typeof config.authorizationStore.savePayment !== "function" ||
    typeof config.authorizationStore.loadCheckout !== "function" ||
    typeof config.authorizationStore.loadPayment !== "function" ||
    !config.addressCodec ||
    !config.chainProvider ||
    !config.voucherVerifier ||
    (config.paymentScheme !== "exact" && config.paymentScheme !== "batch-settlement") ||
    (config.paymentScheme === "exact" && !config.exactTransactionVerifier) ||
    (config.paymentScheme === "batch-settlement" && config.exactTransactionVerifier !== undefined) ||
    (config.paymentScheme === "batch-settlement" && config.exactProfile !== undefined) ||
    (config.paymentScheme === "batch-settlement" && !config.claimBuilder) ||
    (config.paymentScheme === "exact" && config.claimBuilder !== undefined) ||
    (config.paymentScheme === "batch-settlement" &&
      (!POSITIVE_SOMPI_PATTERN.test(config.batchMinDepositSompi ?? "") ||
        !POSITIVE_SOMPI_PATTERN.test(config.batchRefundTimeoutDaa ?? "") ||
        !POSITIVE_SOMPI_PATTERN.test(config.batchChargeAtomic ?? "") ||
        BigInt(config.batchChargeAtomic ?? "0") > BigInt(config.amountAtomic))) ||
    (config.paymentScheme === "exact" &&
      (config.batchMinDepositSompi !== undefined ||
        config.batchRefundTimeoutDaa !== undefined ||
        config.batchChargeAtomic !== undefined)) ||
    (config.exactProfile !== undefined &&
      config.exactProfile !== "standard-native" &&
      config.exactProfile !== "additive") ||
    !config.serverPublicKey ||
    config.merchantCheckoutSigner?.role !== "merchant-checkout" ||
    config.merchantCheckoutSigner.issuer !== config.merchantOrigin ||
    config.merchantReceiptSigner?.role !== "merchant-receipt" ||
    config.paymentReceiptSigner?.role !== "payment-receipt" ||
    typeof config.ap2Trust?.resolve !== "function"
  ) {
    throw new DemoMerchantError("invalid_configuration");
  }
}

function receiptEnrichingStore(
  store: ServerStateStore,
  context: AsyncLocalStorage<BatchReceiptContext>
): ServerStateStore {
  const commitSettlement = async (record: SettlementCommit): Promise<void> => {
    const active = context.getStore();
    if (!active) throw new DemoMerchantError("receipt_failure");
    const artifact = await active.issuePaymentReceipt(record.commitment.commitmentId);
    record.commitment.response.headers[PAYMENT_RECEIPT_HEADER] = artifact;
    if (record.paymentIdentifier && record.paymentIdentifier.response !== record.commitment.response) {
      record.paymentIdentifier.response.headers[PAYMENT_RECEIPT_HEADER] = artifact;
    }
    await store.commitSettlement(record);
    active.paymentReceiptArtifact = artifact;
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === "commitSettlement") return commitSettlement;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function requirePaymentIdentifier(value: unknown): string {
  if (typeof value !== "string" || !PAYMENT_IDENTIFIER_PATTERN.test(value)) {
    throw new DemoMerchantError("payment_mismatch");
  }
  return value;
}

function exactPurchaseId(
  value: unknown,
  code: DemoMerchantError["code"]
): PurchaseId {
  if (typeof value !== "string") throw new DemoMerchantError(code);
  try {
    return assertPurchaseId(value);
  } catch {
    throw new DemoMerchantError(code);
  }
}

function clockSeconds(now: () => number): number {
  return Math.floor(timestamp(now) / 1000);
}

function timestamp(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    throw new DemoMerchantError("invalid_configuration");
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DemoMerchantError("invalid_configuration");
  }
  return value;
}

function isCanonicalOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.origin === value
    );
  } catch {
    return false;
  }
}

function isCanonicalUrl(value: string): boolean {
  try {
    return new URL(value).toString() === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}
