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
  VoucherVerifier,
} from "@kaspa-x402/server";

import {
  assertPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "../purchase/identity.js";
import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import { SUPPORTED_PROTOCOL_PROFILES } from "../protocols/profiles.js";
export const DEMO_NETWORK = "kaspa:testnet-10" as const;
const KAS_ASSET = "KAS" as const;

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
  readonly paymentRequired: ServerResponse;
  readonly paymentRequirementsDigest: Sha256Digest;
}

export interface DemoMerchantOfferArtifacts {
  readonly purchaseId: PurchaseId;
  readonly paymentRequiredHeader: string;
}

export interface DemoMerchantPaidRequest {
  readonly purchaseId: PurchaseId;
  /** Exact standard PAYMENT-REQUIRED value originally bound into the Checkout. */
  readonly paymentRequiredHeader: string;
  readonly paymentIdentifier: string;
  readonly headers: Record<string, string>;
}

interface DemoMerchantEvidenceJoinsCommon {
  readonly purchaseId: PurchaseId;
  readonly requestFingerprint: Sha256Digest;
  readonly paymentRequirementsDigest: Sha256Digest;
  readonly paymentIdentifier: string;
  readonly x402PaymentRequirementsHash: Hash32Hex;
  readonly x402PaymentPayloadHash: Hash32Hex;
  readonly networkConfirmationId: Hash32Hex;
  readonly executionProfile: string;
  readonly maximumAuthorizedChargeAtomic: SompiString;
  readonly actualChargeAtomic: SompiString;
  readonly settlementDigest: Sha256Digest;
  readonly resourceDigest: Sha256Digest;
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
  readonly evidence?: DemoMerchantEvidenceJoins;
}

export interface DemoMerchantFixtureConfig {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantOrigin: string;
  readonly payTo: string;
  readonly amountAtomic: SompiString;
  readonly resource: DemoResource;
  readonly store: ServerStateStore;
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
    | "payment_mismatch"
    ;

  constructor(code: DemoMerchantError["code"]) {
    const messages = {
      invalid_configuration: "demo Merchant configuration is invalid",
      invalid_checkout: "demo Merchant Checkout is invalid",
      payment_mismatch: "demo Merchant payment does not match the x402 offer",
    } as const;
    super(messages[code]);
    this.name = "DemoMerchantError";
    this.code = code;
  }
}

export class DemoMerchantFixture {
  private readonly resourceBytes: Uint8Array;
  private readonly resourceDigest: Sha256Digest;
  private readonly resourceFingerprint: Sha256Digest;

  private constructor(
    private readonly config: DemoMerchantFixtureConfig,
    private readonly server: DirectModeServer,
  ) {
    validateConfiguration(config);
    this.resourceBytes = Uint8Array.from(config.resource.body);
    this.resourceDigest = evidenceDigest(this.resourceBytes);
    this.resourceFingerprint = requestFingerprint({
      url: config.resource.url,
      method: config.resource.method,
    });
  }

  static async create(config: DemoMerchantFixtureConfig): Promise<DemoMerchantFixture> {
    validateConfiguration(config);
    let module: typeof import("@kaspa-x402/server");
    try {
      module = await import("@kaspa-x402/server");
    } catch {
      throw new DemoMerchantError("invalid_configuration");
    }
    const serverConfig: DirectModeServerConfig = {
      network: DEMO_NETWORK,
      asset: KAS_ASSET,
      payTo: config.payTo,
      serverPublicKey: config.serverPublicKey,
      minDepositSompi: config.batchMinDepositSompi ?? "1",
      amount: config.amountAtomic,
      refundTimeoutDaa: config.batchRefundTimeoutDaa ?? "1",
      maxTimeoutSeconds: 60,
      store: config.store,
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
      new module.DirectModeServer(serverConfig)
    );
  }

  async offer(purchaseIdValue: PurchaseId): Promise<DemoMerchantOffer> {
    const purchaseId = exactPurchaseId(purchaseIdValue, "invalid_checkout");
    const requestHash = requestHashHex(this.resourceFingerprint);
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
    return Object.freeze({
      purchaseId,
      paymentRequired,
      paymentRequirementsDigest,
    });
  }

  /** Rehydrate exact previously-issued offer bytes without minting replacement terms. */
  async restoreOffer(input: DemoMerchantOfferArtifacts): Promise<DemoMerchantOffer> {
    const purchaseId = exactPurchaseId(input?.purchaseId, "invalid_checkout");
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
    return Object.freeze({
      purchaseId,
      paymentRequired: Object.freeze({
        status: 402,
        headers: Object.freeze({ [PAYMENT_REQUIRED_HEADER]: paymentRequiredHeader }),
      }),
      paymentRequirementsDigest,
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

    requireHeader(
      request?.headers,
      PAYMENT_SIGNATURE_HEADER,
      "payment_mismatch"
    );
    const requestHash = requestHashHex(this.resourceFingerprint);
    const paymentPayload = assertPaymentSignatureJoins(
      request?.headers,
      paymentRequired.accepts[0],
      requestHash,
      paymentIdentifier
    );
    const response = await this.server.handlePaidRequest(
        this.serverRequest(request.headers, requestHash),
        async ({ payment, requestFingerprint: paidFingerprint, paymentIdentifier: paidId }) => {
          if (
            payment.scheme !== this.config.paymentScheme ||
            paidId !== paymentIdentifier ||
            paidFingerprint !== requestHash ||
            stableStringify(payment.accepted) !== stableStringify(paymentRequired.accepts[0]) ||
            payment.accepted.network !== DEMO_NETWORK ||
            payment.accepted.amount !== this.config.amountAtomic ||
            payment.accepted.payTo !== this.config.payTo ||
            (payment.scheme === "exact" && payment.finality !== "accepted")
          ) {
            throw new DemoMerchantError("payment_mismatch");
          }
          return {
            status: 200,
            headers: { "content-type": this.config.resource.mediaType },
            body: Buffer.from(this.resourceBytes).toString("base64url"),
            chargedAmount: this.config.paymentScheme === "batch-settlement"
              ? this.config.batchChargeAtomic
              : this.config.amountAtomic,
          };
        }
    );
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
      paymentIdentifier,
      requestHash,
      paymentRequirement: paymentRequired.accepts[0],
      paymentPayload,
      resourceBody: this.resourceBytes,
    });

    const evidence = Object.freeze({
      purchaseId,
      requestFingerprint: this.resourceFingerprint,
      paymentRequirementsDigest,
      paymentIdentifier,
      x402PaymentRequirementsHash: paymentEvidence.paymentRequirementsHash,
      x402PaymentPayloadHash: paymentEvidence.paymentPayloadHash,
      networkConfirmationId: paymentEvidence.networkConfirmationId,
      executionProfile: paymentEvidence.executionProfile,
      maximumAuthorizedChargeAtomic: this.config.amountAtomic,
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
    } satisfies DemoMerchantEvidenceJoins);
    return Object.freeze({
      response,
      resource: Object.freeze({
        body: Uint8Array.from(this.resourceBytes),
        digest: this.resourceDigest,
        mediaType: this.config.resource.mediaType,
      }),
      settlement: payment.settlement,
      evidence,
    });
  }

  private assertBatchMerchant(): void {
    if (this.config.paymentScheme !== "batch-settlement" || !this.config.claimBuilder) {
      throw new DemoMerchantError("invalid_configuration");
    }
  }


  private async paymentEvidence(input: {
    payment: PaymentIdentifierRecord;
    response: ServerResponse;
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
      assertExactPaymentJoinsOffer({
        ...input,
        paymentRequirement: input.paymentRequirement,
        exact,
        amountAtomic: this.config.amountAtomic,
      });
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
    assertBatchPaymentJoinsOffer({
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

function assertExactPaymentJoinsOffer(input: {
  payment: PaymentIdentifierRecord;
  exact: NonNullable<Awaited<ReturnType<ServerStateStore["loadExactPayment"]>>>;
  response: ServerResponse;
  amountAtomic: SompiString;
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
    amountAtomic,
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
    payment.settlement.network !== DEMO_NETWORK ||
    payment.settlement.amount !== amountAtomic ||
    exact.requestFingerprint !== requestHash ||
    exact.paymentRequirementsHash !== requirementHash ||
    exact.paymentPayloadHash !== payloadHash ||
    exact.amount !== amountAtomic ||
    exact.finality !== "accepted" ||
    stableStringify(exact.response) !== stableStringify(response) ||
    stableStringify(payment.response) !== stableStringify(response) ||
    stableStringify(wireSettlement) !== stableStringify(payment.settlement) ||
    response.body !== Buffer.from(resourceBody).toString("base64url")
  ) {
    throw new DemoMerchantError("payment_mismatch");
  }
}

function assertBatchPaymentJoinsOffer(input: {
  payment: PaymentIdentifierRecord;
  commitment: NonNullable<Awaited<ReturnType<ServerStateStore["loadCommitment"]>>>;
  response: ServerResponse;
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
    payment.settlement.network !== DEMO_NETWORK ||
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

function validateConfiguration(config: DemoMerchantFixtureConfig): void {
  if (
    !config ||
    !ID_PATTERN.test(config.merchantId) ||
    config.merchantName.length === 0 ||
    config.merchantName.length > 160 ||
    !isCanonicalOrigin(config.merchantOrigin) ||
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
    !config.payTo.startsWith("kaspatest:") ||
    !config.store ||
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
    !config.serverPublicKey
  ) {
    throw new DemoMerchantError("invalid_configuration");
  }
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
