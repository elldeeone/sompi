import { canonicalEvidenceJson } from "../../purchase/canonical-json.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type {
  FulfilmentResult,
  PurchaseReceiptResult,
  VerifiedArtifact,
} from "../../purchase/coordinator.js";
import type { PurchaseId, Sha256Digest } from "../../purchase/types.js";
import type {
  PaidResourceResponse,
  PaidResourceResponseVerifier,
} from "../../purchase/paid-resource-response.js";
import {
  verifyCheckoutReceipt,
  verifyPaymentReceipt,
} from "./receipts.js";
import {
  KASPA_TESTNET_NETWORK,
  KAS_ASSET,
  SOMPI_MERCHANT_CHECKOUT_PROFILE,
  SOMPI_MERCHANT_RECEIPT_PROFILE,
  SOMPI_PAYMENT_RECEIPT_PROFILE,
  type Ap2PublicKeyResolver,
  type VerifiedAp2Receipt,
  type VerifiedHumanPresentMandates,
  type VerifiedMerchantCheckout,
} from "./types.js";

export const SOMPI_CHECKOUT_RECEIPT_HEADER = "SOMPI-CHECKOUT-RECEIPT" as const;
export const SOMPI_PAYMENT_RECEIPT_HEADER = "SOMPI-PAYMENT-RECEIPT" as const;
export const AP2_PAID_RESPONSE_VERIFIER_PROFILE =
  "urn:sompi:ap2:paid-response-verifier:1" as const;

const VERIFIER_ID = "sompi-ap2-paid-response-v1";
const RECEIPT_MEDIA_TYPE = "application/jwt";
const MAX_RECEIPT_HEADER_BYTES = 64 * 1024;
const MAX_MEDIA_TYPE_BYTES = 200;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const PAYMENT_IDENTIFIER_PATTERN = /^pay_[A-Za-z0-9_-]{43}$/;
const HASH32_PATTERN = /^[a-f0-9]{64}$/;

export interface VerifiedAp2CommerceEvidence {
  readonly checkout: VerifiedMerchantCheckout;
  readonly mandates: VerifiedHumanPresentMandates;
  /** Digest of the exact independently verified authority decision artifact. */
  readonly authorizationEvidenceDigest: Sha256Digest;
}

/**
 * Injected TCB boundary. Implementations must load already-verified exact AP2
 * bytes for one Purchase; they must not infer evidence from the HTTP response.
 */
export interface Ap2CommerceEvidenceSource {
  load(purchaseId: PurchaseId): Promise<VerifiedAp2CommerceEvidence | undefined>;
}

export interface Ap2PaidResponseVerifierOptions {
  readonly evidenceSource: Ap2CommerceEvidenceSource;
  readonly trust: Ap2PublicKeyResolver;
  readonly expectedMerchantReceiptIssuer: string;
  readonly expectedPaymentReceiptIssuer: string;
  readonly now?: () => number;
}

export type Ap2PaidResponseVerificationErrorCode =
  | "invalid_configuration"
  | "evidence_unavailable"
  | "binding_mismatch"
  | "receipt_invalid"
  | "fulfilment_invalid";

export class Ap2PaidResponseVerificationError extends Error {
  constructor(
    readonly code: Ap2PaidResponseVerificationErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "Ap2PaidResponseVerificationError";
  }
}

/** Production AP2 verifier for a bounded successful Kaspa-x402 HTTP response. */
export class Ap2PaidResponseVerifier implements PaidResourceResponseVerifier {
  private readonly evidenceSource: Ap2CommerceEvidenceSource;
  private readonly trust: Ap2PublicKeyResolver;
  private readonly expectedMerchantReceiptIssuer: string;
  private readonly expectedPaymentReceiptIssuer: string;
  private readonly now: () => number;

  constructor(options: Ap2PaidResponseVerifierOptions) {
    if (
      typeof options?.evidenceSource?.load !== "function" ||
      typeof options?.trust?.resolve !== "function" ||
      !boundedIdentity(options?.expectedMerchantReceiptIssuer) ||
      !boundedIdentity(options?.expectedPaymentReceiptIssuer)
    ) {
      throw new Ap2PaidResponseVerificationError(
        "invalid_configuration",
        "AP2 paid-response verifier configuration is invalid"
      );
    }
    this.evidenceSource = options.evidenceSource;
    this.trust = options.trust;
    this.expectedMerchantReceiptIssuer = options.expectedMerchantReceiptIssuer;
    this.expectedPaymentReceiptIssuer = options.expectedPaymentReceiptIssuer;
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async verify(
    input: Readonly<PaidResourceResponse>
  ): Promise<Extract<FulfilmentResult, { status: "fulfilled" }> | undefined> {
    if (!input || !Number.isSafeInteger(input.status)) {
      throw new Ap2PaidResponseVerificationError(
        "binding_mismatch",
        "paid HTTP response status is invalid"
      );
    }
    if (input.status < 200 || input.status > 299) return undefined;

    // Copy every caller-owned byte sequence before the first await. The
    // verified result can never alias mutable transport or journal buffers.
    const body = copyBytes(input.body, "paid HTTP response body");
    const headers = copyHeaders(input.headers);
    const context = clonePlain(input.context, "paid response Purchase context");
    const settlement = clonePlain(input.settlement, "paid response Settlement");
    const mediaType = canonicalMediaType(input.mediaType ?? "application/octet-stream");
    const purchaseId = requirePurchaseId(context.purchaseId);

    let loaded: VerifiedAp2CommerceEvidence | undefined;
    try {
      loaded = await this.evidenceSource.load(purchaseId);
    } catch (error) {
      throw new Ap2PaidResponseVerificationError(
        "evidence_unavailable",
        "verified AP2 commerce evidence could not be loaded",
        { cause: error }
      );
    }
    if (!loaded) {
      throw new Ap2PaidResponseVerificationError(
        "evidence_unavailable",
        "verified AP2 commerce evidence is unavailable"
      );
    }
    const evidence = clonePlain(loaded, "verified AP2 commerce evidence");
    assertExactKeys(evidence, ["authorizationEvidenceDigest", "checkout", "mandates"]);
    assertCommerceEvidenceJoins(evidence, context);

    const fulfilment = evidence.checkout.fulfilment;
    if (
      !fulfilment ||
      !boundedIdentity(fulfilment.identity) ||
      fulfilment.identity !== evidence.checkout.claims.fulfilment?.identity ||
      !fulfilment.expectedDigest ||
      fulfilment.expectedDigest !== evidence.checkout.claims.fulfilment?.expected_digest
    ) {
      throw new Ap2PaidResponseVerificationError(
        "fulfilment_invalid",
        "Merchant Checkout does not contain one exact verifiable Fulfilment identity"
      );
    }
    const fulfilmentDigest = evidenceDigest(body);
    if (fulfilmentDigest !== fulfilment.expectedDigest) {
      throw new Ap2PaidResponseVerificationError(
        "fulfilment_invalid",
        "paid response body does not match the authorized Fulfilment digest"
      );
    }

    const checkoutReceiptArtifact = requireSingleReceiptHeader(
      headers,
      SOMPI_CHECKOUT_RECEIPT_HEADER
    );
    const paymentReceiptArtifact = requireSingleReceiptHeader(
      headers,
      SOMPI_PAYMENT_RECEIPT_HEADER
    );
    const nowSec = Math.floor(readClock(this.now) / 1000);
    const paymentIdentifier = requirePaymentIdentifier(
      context.paymentIdentifier
    );
    let checkoutReceipt: VerifiedAp2Receipt;
    let paymentReceipt: VerifiedAp2Receipt;
    try {
      [checkoutReceipt, paymentReceipt] = await Promise.all([
        verifyCheckoutReceipt(checkoutReceiptArtifact, {
          trust: this.trust,
          expectedIssuer: this.expectedMerchantReceiptIssuer,
          mandate: evidence.mandates.checkout,
          nowSec,
          clockSkewSec: 0,
        }),
        verifyPaymentReceipt(paymentReceiptArtifact, {
          trust: this.trust,
          expectedIssuer: this.expectedPaymentReceiptIssuer,
          mandate: evidence.mandates.payment,
          expectedPaymentId: paymentIdentifier,
          nowSec,
          clockSkewSec: 0,
        }),
      ]);
    } catch (error) {
      throw new Ap2PaidResponseVerificationError(
        "receipt_invalid",
        "AP2 paid-response Receipt verification failed",
        { cause: error }
      );
    }

    const executionConfirmationId = requireSettlementExecutionId(settlement);
    assertReceiptJoins(
      checkoutReceipt,
      paymentReceipt,
      purchaseId,
      paymentIdentifier,
      executionConfirmationId,
      evidence.mandates
    );
    const settlementEvidenceDigest = verifiedArtifactDigest(
      settlement.evidence,
      "Settlement evidence"
    );
    assertSettlementJoins(settlement, context, executionConfirmationId);
    const checkoutDigest = requireDigest(context.terms.checkoutDigest);
    const authorizationEvidenceDigest = requireDigest(
      evidence.authorizationEvidenceDigest
    );
    const exactJoin = Object.freeze({
      purchaseId,
      checkoutDigest,
      authorizationEvidenceDigest,
      settlementEvidenceDigest,
      fulfilmentIdentity: fulfilment.identity,
      fulfilmentDigest,
      paymentIdentifier,
      executionConfirmationId,
    });

    const merchantEvidence = verifiedArtifact({
      bytes: Buffer.from(evidence.checkout.artifact, "utf8"),
      profile: evidence.checkout.profile,
      issuer: evidence.checkout.issuer,
      declaredDigest: checkoutDigest,
      detail: { kind: "merchant-checkout", ...exactJoin },
    });
    const receipts: readonly PurchaseReceiptResult[] = Object.freeze([
      purchaseReceiptJoin({
        role: "merchant",
        receipt: checkoutReceipt,
        artifact: checkoutReceiptArtifact,
        checkoutDigest,
        authorizationEvidenceDigest,
        settlementEvidenceDigest,
        fulfilmentDigest,
        detail: exactJoin,
      }),
      purchaseReceiptJoin({
        role: "payment",
        receipt: paymentReceipt,
        artifact: paymentReceiptArtifact,
        checkoutDigest,
        authorizationEvidenceDigest,
        settlementEvidenceDigest,
        fulfilmentDigest,
        detail: exactJoin,
      }),
    ]);

    return Object.freeze({
      status: "fulfilled" as const,
      httpStatus: input.status,
      body: Uint8Array.from(body),
      mediaType,
      resourceFingerprint: context.request.requestFingerprint,
      merchantEvidence,
      receipts,
    });
  }
}

function assertCommerceEvidenceJoins(
  evidence: VerifiedAp2CommerceEvidence,
  context: PaidResourceResponse["context"]
): void {
  const { checkout, mandates } = evidence;
  const terms = context.terms;
  const authorization = context.authorization;
  const authorizationRequest = context.authorizationRequest;
  if (
    checkout.profile !== SOMPI_MERCHANT_CHECKOUT_PROFILE ||
    evidenceDigest(checkout.artifact) !== checkout.checkoutDigest ||
    checkout.purchaseId !== context.purchaseId ||
    checkout.checkoutDigest !== terms.checkoutDigest ||
    checkout.terms.checkoutDigest !== terms.checkoutDigest ||
    checkout.terms.expiresAt !== terms.expiresAt ||
    checkout.terms.resourceFingerprint !== context.request.requestFingerprint ||
    checkout.terms.resourceFingerprint !== terms.resourceFingerprint ||
    checkout.terms.merchant.id !== terms.merchant.id ||
    checkout.terms.merchant.name !== terms.merchant.name ||
    checkout.terms.merchant.origin !== terms.merchant.origin ||
    checkout.terms.amountAtomic !== terms.amountAtomic ||
    checkout.terms.asset !== terms.asset ||
    checkout.terms.network !== terms.network ||
    checkout.terms.payTo !== terms.payTo ||
    checkout.resourceUrl !== context.request.url ||
    checkout.method !== context.request.method ||
    checkout.paymentRequirementsDigest !== evidenceDigest(context.paymentRequirements) ||
    checkout.additionalCostCeilingAtomic !== authorizationRequest.additionalCostCeilingAtomic ||
    authorization.decision !== "approved" ||
    authorization.purchaseId !== context.purchaseId ||
    authorization.checkoutDigest !== terms.checkoutDigest ||
    authorization.evidenceDigest !== evidence.authorizationEvidenceDigest ||
    authorizationRequest.purchaseId !== context.purchaseId ||
    authorizationRequest.resourceUrl !== context.request.url ||
    authorizationRequest.method !== context.request.method ||
    authorizationRequest.terms.checkoutDigest !== terms.checkoutDigest ||
    authorizationRequest.terms.resourceFingerprint !== terms.resourceFingerprint
  ) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      "verified AP2 commerce evidence does not match the exact Purchase"
    );
  }
  requireDigest(evidence.authorizationEvidenceDigest);
  assertMandatesMatchCheckout(mandates, checkout);
}

function assertMandatesMatchCheckout(
  mandates: VerifiedHumanPresentMandates,
  checkout: VerifiedMerchantCheckout
): void {
  if (
    !mandates ||
    mandates.checkout.content.checkout_jwt !== checkout.artifact ||
    mandates.checkout.content.checkout_hash !== checkout.checkoutHash ||
    mandates.payment.content.transaction_id !== checkout.checkoutHash ||
    mandates.payment.amountAtomic !== checkout.terms.amountAtomic ||
    mandates.payment.network !== KASPA_TESTNET_NETWORK ||
    mandates.payment.asset !== KAS_ASSET ||
    mandates.payment.content.payee.id !== checkout.terms.merchant.id ||
    mandates.payment.content.payee.name !== checkout.terms.merchant.name ||
    mandates.payment.content.payee.website !== checkout.claims.merchant.website ||
    mandates.checkout.authorityIssuer !== mandates.payment.authorityIssuer ||
    mandates.checkout.kid !== mandates.payment.kid ||
    mandates.checkout.content.iat !== mandates.payment.content.iat ||
    mandates.checkout.content.exp !== mandates.payment.content.exp
  ) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      "verified AP2 mandates do not match the exact Merchant Checkout"
    );
  }
}

function assertReceiptJoins(
  checkoutReceipt: VerifiedAp2Receipt,
  paymentReceipt: VerifiedAp2Receipt,
  purchaseId: PurchaseId,
  paymentIdentifier: string,
  executionConfirmationId: string,
  mandates: VerifiedHumanPresentMandates
): void {
  if (
    checkoutReceipt.role !== "merchant" ||
    checkoutReceipt.profile !== SOMPI_MERCHANT_RECEIPT_PROFILE ||
    checkoutReceipt.status !== "Success" ||
    checkoutReceipt.reference !== mandates.checkout.issuerJwtReference ||
    checkoutReceipt.orderId !== purchaseId ||
    paymentReceipt.role !== "payment" ||
    paymentReceipt.profile !== SOMPI_PAYMENT_RECEIPT_PROFILE ||
    paymentReceipt.status !== "Success" ||
    paymentReceipt.reference !== mandates.payment.issuerJwtReference ||
    paymentReceipt.paymentId !== paymentIdentifier ||
    paymentReceipt.pspConfirmationId !== paymentIdentifier ||
    paymentReceipt.networkConfirmationId !== executionConfirmationId
  ) {
    throw new Ap2PaidResponseVerificationError(
      "receipt_invalid",
      "AP2 Receipts do not join the exact Purchase payment and mandates"
    );
  }
}

function assertSettlementJoins(
  settlement: PaidResourceResponse["settlement"],
  context: PaidResourceResponse["context"],
  executionConfirmationId: string
): void {
  const terms = context.terms;
  const amount = requireAtomic(settlement.amountAtomic, "Settlement amount");
  const maximum = requireAtomic(terms.amountAtomic, "authorized Purchase amount");
  const amountMatches = settlement.mechanism === "single-transaction"
    ? amount === maximum
    : amount > 0n && amount <= maximum;
  if (
    settlement.executionId !== context.preparedExecutionId ||
    settlement.mechanism !== context.authorizationRequest.executionMechanism ||
    settlement.profile !== context.authorizationRequest.executionProfile ||
    settlement.settlementAssurance !== context.authorizationRequest.settlementAssurance ||
    !amountMatches ||
    settlement.asset !== terms.asset ||
    settlement.network !== terms.network ||
    settlement.payTo !== terms.payTo ||
    settlement.fundingSource !== "vault-treasury"
  ) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      "Settlement does not match the paid Purchase execution"
    );
  }
}

function purchaseReceiptJoin(input: {
  role: "merchant" | "payment";
  receipt: VerifiedAp2Receipt;
  artifact: string;
  checkoutDigest: Sha256Digest;
  authorizationEvidenceDigest: Sha256Digest;
  settlementEvidenceDigest: Sha256Digest;
  fulfilmentDigest: Sha256Digest;
  detail: Record<string, unknown>;
}): PurchaseReceiptResult {
  return Object.freeze({
    role: input.role,
    checkoutDigest: input.checkoutDigest,
    authorizationEvidenceDigest: input.authorizationEvidenceDigest,
    settlementEvidenceDigest: input.settlementEvidenceDigest,
    fulfilmentDigest: input.fulfilmentDigest,
    evidence: verifiedArtifact({
      bytes: Buffer.from(input.artifact, "utf8"),
      profile: input.receipt.profile,
      issuer: input.receipt.issuer,
      declaredDigest: evidenceDigest(input.artifact),
      detail: {
        kind: `${input.role}-receipt`,
        receiptReference: input.receipt.reference,
        ...input.detail,
      },
    }),
  });
}

function verifiedArtifact(input: {
  bytes: Uint8Array;
  profile: string;
  issuer: string;
  declaredDigest: Sha256Digest;
  detail: Record<string, unknown>;
}): VerifiedArtifact {
  return Object.freeze({
    bytes: Uint8Array.from(input.bytes),
    mediaType: RECEIPT_MEDIA_TYPE,
    profile: input.profile,
    issuer: input.issuer,
    declaredDigest: input.declaredDigest,
    verification: Object.freeze({
      verifierId: VERIFIER_ID,
      // VerifiedArtifact requires the verification to attest the exact
      // artifact profile. The verifier implementation is identified by
      // verifierId; it is not a replacement wire/evidence profile.
      profile: input.profile,
      detailDigest: evidenceDigest(canonicalEvidenceJson(input.detail)),
    }),
  });
}

function verifiedArtifactDigest(artifact: VerifiedArtifact, label: string): Sha256Digest {
  if (
    !artifact ||
    !(artifact.bytes instanceof Uint8Array) ||
    artifact.bytes.byteLength === 0
  ) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      `${label} is unavailable`
    );
  }
  const digest = evidenceDigest(artifact.bytes);
  if (artifact.declaredDigest !== undefined && artifact.declaredDigest !== digest) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      `${label} declared digest does not match its exact bytes`
    );
  }
  return digest;
}

function requireSingleReceiptHeader(
  headers: readonly (readonly [string, string])[],
  name: string
): string {
  const values = headers
    .filter(([candidate]) => candidate.toUpperCase() === name)
    .map(([, value]) => value);
  if (values.length !== 1) {
    throw new Ap2PaidResponseVerificationError(
      "receipt_invalid",
      `${name} must occur exactly once`
    );
  }
  const value = values[0];
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RECEIPT_HEADER_BYTES ||
    /[^\x21-\x7e]/.test(value)
  ) {
    throw new Ap2PaidResponseVerificationError(
      "receipt_invalid",
      `${name} is not a bounded compact artifact`
    );
  }
  return value;
}

function copyHeaders(
  candidate: readonly (readonly [string, string])[]
): readonly (readonly [string, string])[] {
  if (!Array.isArray(candidate) || candidate.length > 256) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      "paid HTTP response headers are invalid"
    );
  }
  return Object.freeze(candidate.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry[0]) ||
      /[\r\n]/.test(entry[1])
    ) {
      throw new Ap2PaidResponseVerificationError(
        "binding_mismatch",
        "paid HTTP response header entry is invalid"
      );
    }
    return Object.freeze([entry[0], entry[1]] as const);
  }));
}

function copyBytes(candidate: Uint8Array, label: string): Uint8Array {
  if (!(candidate instanceof Uint8Array)) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      `${label} is invalid`
    );
  }
  return Uint8Array.from(candidate);
}

function clonePlain<T>(candidate: T, label: string): T {
  try {
    return structuredClone(candidate);
  } catch (error) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      `${label} is not copyable canonical data`,
      { cause: error }
    );
  }
}

function canonicalMediaType(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_MEDIA_TYPE_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Ap2PaidResponseVerificationError(
      "fulfilment_invalid",
      "paid response media type is invalid"
    );
  }
  return value;
}

function requirePurchaseId(value: unknown): PurchaseId {
  if (typeof value !== "string" || !/^pur_[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      "paid response Purchase ID is invalid"
    );
  }
  return value as PurchaseId;
}

function requirePaymentIdentifier(value: unknown): string {
  if (typeof value !== "string" || !PAYMENT_IDENTIFIER_PATTERN.test(value)) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      "paid response payment identifier is invalid"
    );
  }
  return value;
}

function requireSettlementExecutionId(
  settlement: PaidResourceResponse["settlement"]
): string {
  const value = settlement.mechanism === "single-transaction"
    ? settlement.transactionId
    : settlement.commitmentId;
  if (
    typeof value !== "string" ||
    !HASH32_PATTERN.test(value) ||
    (settlement.mechanism === "single-transaction" && settlement.commitmentId !== undefined) ||
    (settlement.mechanism === "channel-voucher" && settlement.transactionId !== undefined)
  ) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      "paid response execution confirmation is invalid"
    );
  }
  return value;
}

function requireAtomic(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Ap2PaidResponseVerificationError("binding_mismatch", `${label} is invalid`);
  }
  return BigInt(value);
}

function requireDigest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      "paid response evidence digest is invalid"
    );
  }
  return value as Sha256Digest;
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Ap2PaidResponseVerificationError(
      "binding_mismatch",
      "verified AP2 commerce evidence contains unknown or missing fields"
    );
  }
}

function readClock(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch (error) {
    throw new Ap2PaidResponseVerificationError(
      "invalid_configuration",
      "AP2 paid-response verifier clock failed",
      { cause: error }
    );
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Ap2PaidResponseVerificationError(
      "invalid_configuration",
      "AP2 paid-response verifier clock is invalid"
    );
  }
  return value;
}
