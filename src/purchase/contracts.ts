import { assertPurchaseId, canonicalMediaType, canonicalRequestUrl, evidenceDigest } from "./identity.js";
import type {
  CheckoutTerms,
  FundingSource,
  MerchantIdentity,
  PaymentIdentifier,
  PurchaseId,
  Sha256Digest,
} from "./types.js";
import type {
  PurchaseExecutionAssurance,
  PurchaseExecutionMechanism,
} from "./execution-plan.js";

const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const BOUNDED_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const MAX_AMOUNT_DIGITS = 78;
const MAX_MERCHANT_ID_LENGTH = 160;
const MAX_MERCHANT_NAME_LENGTH = 160;
const MAX_ASSET_LENGTH = 64;
const MAX_NETWORK_LENGTH = 128;
const MAX_PAY_TO_LENGTH = 256;
const MAX_AUTHORITY_ID_LENGTH = 160;
const MAX_EXECUTION_ID_LENGTH = 160;

export interface CheckoutTermsExpectation {
  purchaseId: PurchaseId;
  resourceFingerprint: Sha256Digest;
  expectedMerchant?: {
    id?: string;
    origin?: string;
  };
}

/** Canonical protocol-neutral Checkout Terms owned by the Purchase module. */
export interface CanonicalCheckoutTerms extends CheckoutTerms {}

export interface PurchaseAuthorizationRequest {
  purchaseId: PurchaseId;
  resourceUrl: string;
  method: string;
  requestMediaType: string;
  requestBodyDigest: Sha256Digest;
  terms: CanonicalCheckoutTerms;
  requestDigest: Sha256Digest;
  nonceDigest: Sha256Digest;
  additionalCostCeilingAtomic: string;
  effectiveFinalityFloor: "accepted" | "depth-confirmed";
  executionPlanDigest: Sha256Digest;
  executionMechanism: PurchaseExecutionMechanism;
  executionProfile: string;
  settlementAssurance: PurchaseExecutionAssurance;
  maximumAuthorizedChargeAtomic: string;
  channelId?: string;
  channelEpochDigest?: Sha256Digest;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface CanonicalAuthorizationFacts {
  purchaseId: PurchaseId;
  resourceUrl: string;
  method: string;
  requestMediaType: string;
  requestBodyDigest: Sha256Digest;
  resourceFingerprint: Sha256Digest;
  merchantId: string;
  merchantOrigin: string;
  amountAtomic: string;
  asset: string;
  network: string;
  payTo: string;
  expiresAt: string;
  checkoutDigest: Sha256Digest;
  requestDigest: Sha256Digest;
  nonceDigest: Sha256Digest;
  additionalCostCeilingAtomic: string;
  effectiveFinalityFloor: "accepted" | "depth-confirmed";
  executionPlanDigest: Sha256Digest;
  executionMechanism: PurchaseExecutionMechanism;
  executionProfile: string;
  settlementAssurance: PurchaseExecutionAssurance;
  maximumAuthorizedChargeAtomic: string;
  channelId?: string;
  channelEpochDigest?: Sha256Digest;
}

export interface PurchaseAuthorizationDecision {
  purchaseId: PurchaseId;
  checkoutDigest: Sha256Digest;
  decision: "approved" | "denied";
  authorityId: string;
  evidenceDigest: Sha256Digest;
  facts: CanonicalAuthorizationFacts;
}

/** Interface at the authorization seam; a concrete implementation may vary. */
export interface PurchaseAuthorizer {
  authorize(request: PurchaseAuthorizationRequest): Promise<PurchaseAuthorizationDecision>;
}

export interface PurchaseExecutionRequest {
  purchaseId: PurchaseId;
  terms: CanonicalCheckoutTerms;
  authorizationRequest: PurchaseAuthorizationRequest;
  authorization: PurchaseAuthorizationDecision;
  paymentIdentifier: PaymentIdentifier;
}

export interface PreparedPurchasePayment {
  purchaseId: PurchaseId;
  checkoutDigest: Sha256Digest;
  resourceFingerprint: Sha256Digest;
  amountAtomic: string;
  asset: string;
  network: string;
  payTo: string;
  paymentIdentifier: PaymentIdentifier;
  executionId: string;
  preparedDigest: Sha256Digest;
  fundingSource: FundingSource;
}

/** Interface at the execution seam; it exposes no protocol SDK object. */
export interface PurchaseExecutor {
  prepare(request: PurchaseExecutionRequest): Promise<PreparedPurchasePayment>;
}

export class PurchaseContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseContractError";
  }
}

export function validateCheckoutTerms(
  expectation: CheckoutTermsExpectation,
  candidate: CheckoutTerms,
  now: () => number
): CanonicalCheckoutTerms {
  requirePurchaseId(expectation.purchaseId);
  const expectedFingerprint = requireDigest(expectation.resourceFingerprint, "expected resource fingerprint");
  const resourceFingerprint = requireDigest(candidate.resourceFingerprint, "Checkout Terms resource fingerprint");
  if (resourceFingerprint !== expectedFingerprint) {
    throw new PurchaseContractError("Checkout Terms resource fingerprint does not match the Purchase Intent");
  }

  const merchant = validateMerchant(candidate.merchant);
  const expectedMerchantId = expectation.expectedMerchant?.id;
  if (expectedMerchantId !== undefined) {
    const expected = requireBoundedIdentity(expectedMerchantId, "expected merchant id", MAX_MERCHANT_ID_LENGTH);
    if (merchant.id !== expected) throw new PurchaseContractError("Checkout Terms merchant id does not match the expected merchant");
  }
  const expectedMerchantOrigin = expectation.expectedMerchant?.origin;
  if (expectedMerchantOrigin !== undefined) {
    const expected = requireCanonicalOrigin(expectedMerchantOrigin, "expected merchant origin");
    if (merchant.origin !== expected) {
      throw new PurchaseContractError("Checkout Terms merchant origin does not match the expected merchant");
    }
  }

  const amountAtomic = requirePositiveDecimal(candidate.amountAtomic, "Checkout Terms amount");
  const asset = requireBoundedIdentity(candidate.asset, "Checkout Terms asset", MAX_ASSET_LENGTH);
  const network = requireBoundedIdentity(candidate.network, "Checkout Terms network", MAX_NETWORK_LENGTH);
  const payTo = requireBoundedIdentity(candidate.payTo, "Checkout Terms payee", MAX_PAY_TO_LENGTH);
  const expiresAt = requireFutureRfc3339(candidate.expiresAt, now);
  const checkoutDigest = requireDigest(candidate.checkoutDigest, "Checkout Terms digest");

  return {
    merchant,
    resourceFingerprint,
    amountAtomic,
    asset,
    network,
    payTo,
    expiresAt,
    checkoutDigest,
  };
}

export function validateAuthorizationDecision(
  request: PurchaseAuthorizationRequest,
  candidate: PurchaseAuthorizationDecision
): PurchaseAuthorizationDecision {
  const purchaseId = requirePurchaseId(candidate.purchaseId);
  if (purchaseId !== requirePurchaseId(request.purchaseId)) {
    throw new PurchaseContractError("authorization decision is bound to a different Purchase");
  }
  const checkoutDigest = requireDigest(candidate.checkoutDigest, "authorization checkout digest");
  if (checkoutDigest !== request.terms.checkoutDigest) {
    throw new PurchaseContractError("authorization decision is bound to different Checkout Terms");
  }
  if (candidate.decision !== "approved" && candidate.decision !== "denied") {
    throw new PurchaseContractError("authorization decision must be approved or denied");
  }
  const expectedFacts = authorizationFacts(request);
  const candidateFacts = validateAuthorizationFacts(candidate.facts);
  for (const key of Object.keys(expectedFacts) as Array<keyof CanonicalAuthorizationFacts>) {
    if (candidateFacts[key] !== expectedFacts[key]) {
      throw new PurchaseContractError(`authorization decision ${key} does not match the exact Purchase request`);
    }
  }
  return {
    purchaseId,
    checkoutDigest,
    decision: candidate.decision,
    authorityId: requireBoundedIdentity(candidate.authorityId, "authority id", MAX_AUTHORITY_ID_LENGTH),
    evidenceDigest: requireDigest(candidate.evidenceDigest, "authorization evidence digest"),
    facts: candidateFacts,
  };
}

export function authorizationFacts(request: PurchaseAuthorizationRequest): CanonicalAuthorizationFacts {
  const purchaseId = requirePurchaseId(request.purchaseId);
  const resourceUrl = canonicalResourceUrl(request.resourceUrl);
  const method = canonicalMethod(request.method);
  const terms = request.terms;
  if (!Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= 0) {
    throw new PurchaseContractError("authorization request expiry is invalid");
  }
  if (
    !Number.isSafeInteger(request.createdAtMs) ||
    request.createdAtMs <= 0 ||
    request.createdAtMs >= request.expiresAtMs
  ) {
    throw new PurchaseContractError("authorization request creation time is invalid");
  }
  if (request.expiresAtMs > Date.parse(terms.expiresAt)) {
    throw new PurchaseContractError("authorization request outlives Checkout Terms");
  }
  const execution = canonicalAuthorizationExecution(request);
  return {
    purchaseId,
    resourceUrl,
    method,
    requestMediaType: canonicalAuthorizationMediaType(request.requestMediaType),
    requestBodyDigest: requireDigest(request.requestBodyDigest, "authorization request body digest"),
    resourceFingerprint: requireDigest(terms.resourceFingerprint, "authorization resource fingerprint"),
    merchantId: requireBoundedIdentity(terms.merchant.id, "authorization merchant id", MAX_MERCHANT_ID_LENGTH),
    merchantOrigin: requireCanonicalOrigin(terms.merchant.origin, "authorization merchant origin"),
    amountAtomic: requirePositiveDecimal(terms.amountAtomic, "authorization amount"),
    asset: requireBoundedIdentity(terms.asset, "authorization asset", MAX_ASSET_LENGTH),
    network: requireBoundedIdentity(terms.network, "authorization network", MAX_NETWORK_LENGTH),
    payTo: requireBoundedIdentity(terms.payTo, "authorization payee", MAX_PAY_TO_LENGTH),
    expiresAt: terms.expiresAt,
    checkoutDigest: requireDigest(terms.checkoutDigest, "authorization Checkout Terms digest"),
    requestDigest: requireDigest(request.requestDigest, "authorization request digest"),
    nonceDigest: requireDigest(request.nonceDigest, "authorization nonce digest"),
    additionalCostCeilingAtomic: requireNonNegativeDecimal(
      request.additionalCostCeilingAtomic,
      "authorization additional-cost ceiling"
    ),
    effectiveFinalityFloor: requireFinalityFloor(request.effectiveFinalityFloor),
    ...execution,
  };
}

type AuthorizationExecutionFacts = Pick<
  CanonicalAuthorizationFacts,
  | "executionPlanDigest"
  | "executionMechanism"
  | "executionProfile"
  | "settlementAssurance"
  | "maximumAuthorizedChargeAtomic"
  | "channelId"
  | "channelEpochDigest"
>;

function canonicalAuthorizationExecution(
  request: AuthorizationExecutionFacts
): AuthorizationExecutionFacts {
  const executionPlanDigest = requireDigest(request.executionPlanDigest, "authorization execution-plan digest");
  const executionProfile = requireBoundedIdentity(
    request.executionProfile,
    "authorization execution profile",
    160
  );
  const maximumAuthorizedChargeAtomic = requirePositiveDecimal(
    request.maximumAuthorizedChargeAtomic,
    "authorization maximum charge"
  );
  if (
    request.executionMechanism !== "single-transaction" &&
    request.executionMechanism !== "channel-voucher"
  ) {
    throw new PurchaseContractError("authorization execution mechanism is invalid");
  }
  if (
    request.settlementAssurance !== "accepted" &&
    request.settlementAssurance !== "confirmed" &&
    request.settlementAssurance !== "channel-commitment"
  ) {
    throw new PurchaseContractError("authorization settlement assurance is invalid");
  }
  if (request.executionMechanism === "single-transaction") {
    if (
      request.settlementAssurance === "channel-commitment" ||
      request.channelId !== undefined ||
      request.channelEpochDigest !== undefined
    ) {
      throw new PurchaseContractError("single-transaction authorization contains channel facts");
    }
    return {
      executionPlanDigest,
      executionMechanism: request.executionMechanism,
      executionProfile,
      settlementAssurance: request.settlementAssurance,
      maximumAuthorizedChargeAtomic,
    };
  }
  if (
    request.settlementAssurance !== "channel-commitment" ||
    request.channelId === undefined ||
    request.channelEpochDigest === undefined
  ) {
    throw new PurchaseContractError("channel-voucher authorization requires a bound channel epoch");
  }
  const channelId = requireBoundedIdentity(request.channelId, "authorization channel id", 160);
  const channelEpochDigest = requireDigest(
    request.channelEpochDigest,
    "authorization channel-epoch digest"
  );
  return {
    executionPlanDigest,
    executionMechanism: request.executionMechanism,
    executionProfile,
    settlementAssurance: request.settlementAssurance,
    maximumAuthorizedChargeAtomic,
    channelId,
    channelEpochDigest,
  };
}

function requireFinalityFloor(value: unknown): "accepted" | "depth-confirmed" {
  if (value !== "accepted" && value !== "depth-confirmed") {
    throw new PurchaseContractError("authorization effective finality floor is invalid");
  }
  return value;
}

export function authorizationFactsDigest(request: PurchaseAuthorizationRequest): Sha256Digest {
  return evidenceDigest(JSON.stringify(authorizationFacts(request)));
}

/** Digest adapters must derive from the exact canonical terms extracted from signed Checkout bytes. */
export function checkoutTermsFactsDigest(terms: CheckoutTerms): Sha256Digest {
  return evidenceDigest(JSON.stringify({
    merchant: {
      id: terms.merchant.id,
      name: terms.merchant.name,
      origin: terms.merchant.origin,
    },
    resourceFingerprint: terms.resourceFingerprint,
    amountAtomic: terms.amountAtomic,
    asset: terms.asset,
    network: terms.network,
    payTo: terms.payTo,
    expiresAt: terms.expiresAt,
    checkoutDigest: terms.checkoutDigest,
  }));
}

export function validatePreparedPayment(
  request: PurchaseExecutionRequest,
  candidate: PreparedPurchasePayment,
  now: () => number
): PreparedPurchasePayment {
  const purchaseId = requirePurchaseId(request.purchaseId);
  const authorization = validateAuthorizationDecision(
    request.authorizationRequest,
    request.authorization
  );
  if (
    request.authorizationRequest.purchaseId !== purchaseId ||
    request.authorizationRequest.terms.checkoutDigest !== request.terms.checkoutDigest
  ) {
    throw new PurchaseContractError("payment preparation authorization request is misbound");
  }
  if (authorization.decision !== "approved") {
    throw new PurchaseContractError("payment preparation requires an approved authorization decision");
  }
  requireFutureRfc3339(request.terms.expiresAt, now);

  const prepared = {
    purchaseId: requirePurchaseId(candidate.purchaseId),
    checkoutDigest: requireDigest(candidate.checkoutDigest, "prepared payment checkout digest"),
    resourceFingerprint: requireDigest(candidate.resourceFingerprint, "prepared payment resource fingerprint"),
    amountAtomic: requirePositiveDecimal(candidate.amountAtomic, "prepared payment amount"),
    asset: requireBoundedIdentity(candidate.asset, "prepared payment asset", MAX_ASSET_LENGTH),
    network: requireBoundedIdentity(candidate.network, "prepared payment network", MAX_NETWORK_LENGTH),
    payTo: requireBoundedIdentity(candidate.payTo, "prepared payment payee", MAX_PAY_TO_LENGTH),
    paymentIdentifier: candidate.paymentIdentifier,
    executionId: requireBoundedIdentity(candidate.executionId, "prepared payment execution id", MAX_EXECUTION_ID_LENGTH),
    preparedDigest: requireDigest(candidate.preparedDigest, "prepared payment digest"),
    fundingSource: requireFundingSource(candidate.fundingSource),
  };
  requireBoundedIdentity(prepared.paymentIdentifier, "payment identifier", MAX_EXECUTION_ID_LENGTH);

  const exactMatches: ReadonlyArray<[string, string, string]> = [
    ["Purchase", prepared.purchaseId, purchaseId],
    ["checkout digest", prepared.checkoutDigest, request.terms.checkoutDigest],
    ["resource fingerprint", prepared.resourceFingerprint, request.terms.resourceFingerprint],
    ["amount", prepared.amountAtomic, request.terms.amountAtomic],
    ["asset", prepared.asset, request.terms.asset],
    ["network", prepared.network, request.terms.network],
    ["payee", prepared.payTo, request.terms.payTo],
    ["payment identifier", prepared.paymentIdentifier, request.paymentIdentifier],
  ];
  for (const [field, actual, expected] of exactMatches) {
    if (actual !== expected) throw new PurchaseContractError(`prepared payment ${field} does not match the authorized Checkout Terms`);
  }
  return prepared;
}

function validateMerchant(candidate: MerchantIdentity): MerchantIdentity {
  const id = requireBoundedIdentity(candidate.id, "merchant id", MAX_MERCHANT_ID_LENGTH);
  const name = requireBoundedText(candidate.name, "merchant name", MAX_MERCHANT_NAME_LENGTH);
  const origin = requireCanonicalOrigin(candidate.origin, "merchant origin");
  return { id, name, origin };
}

function validateAuthorizationFacts(candidate: CanonicalAuthorizationFacts): CanonicalAuthorizationFacts {
  const execution = canonicalAuthorizationExecution(candidate);
  return {
    purchaseId: requirePurchaseId(candidate.purchaseId),
    resourceUrl: canonicalResourceUrl(candidate.resourceUrl),
    method: canonicalMethod(candidate.method),
    requestMediaType: canonicalAuthorizationMediaType(candidate.requestMediaType),
    requestBodyDigest: requireDigest(candidate.requestBodyDigest, "authorization fact request body digest"),
    resourceFingerprint: requireDigest(candidate.resourceFingerprint, "authorization fact resource fingerprint"),
    merchantId: requireBoundedIdentity(candidate.merchantId, "authorization fact merchant id", MAX_MERCHANT_ID_LENGTH),
    merchantOrigin: requireCanonicalOrigin(candidate.merchantOrigin, "authorization fact merchant origin"),
    amountAtomic: requirePositiveDecimal(candidate.amountAtomic, "authorization fact amount"),
    asset: requireBoundedIdentity(candidate.asset, "authorization fact asset", MAX_ASSET_LENGTH),
    network: requireBoundedIdentity(candidate.network, "authorization fact network", MAX_NETWORK_LENGTH),
    payTo: requireBoundedIdentity(candidate.payTo, "authorization fact payee", MAX_PAY_TO_LENGTH),
    expiresAt: candidate.expiresAt,
    checkoutDigest: requireDigest(candidate.checkoutDigest, "authorization fact Checkout Terms digest"),
    requestDigest: requireDigest(candidate.requestDigest, "authorization fact request digest"),
    nonceDigest: requireDigest(candidate.nonceDigest, "authorization fact nonce digest"),
    additionalCostCeilingAtomic: requireNonNegativeDecimal(
      candidate.additionalCostCeilingAtomic,
      "authorization fact additional-cost ceiling"
    ),
    effectiveFinalityFloor: requireFinalityFloor(candidate.effectiveFinalityFloor),
    ...execution,
  };
}

function canonicalResourceUrl(value: string): string {
  let canonical: string;
  try {
    canonical = canonicalRequestUrl(value);
  } catch (error) {
    throw new PurchaseContractError(`authorization resource URL is invalid: ${error instanceof Error ? error.message : "invalid value"}`);
  }
  if (canonical !== value) throw new PurchaseContractError("authorization resource URL must be canonical");
  return canonical;
}

function canonicalMethod(value: string): string {
  if (!/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(value)) {
    throw new PurchaseContractError("authorization HTTP method must be canonical");
  }
  return value;
}

function canonicalAuthorizationMediaType(value: string): string {
  try {
    const canonical = canonicalMediaType(value || undefined) ?? "";
    if (canonical !== value) throw new Error("not canonical");
    return canonical;
  } catch {
    throw new PurchaseContractError("authorization request media type must be canonical");
  }
}

function requireFundingSource(value: FundingSource): FundingSource {
  if (value !== "vault-treasury") {
    throw new PurchaseContractError("prepared payment must use vault-treasury funding");
  }
  return value;
}

function requirePurchaseId(value: PurchaseId): PurchaseId {
  try {
    return assertPurchaseId(value);
  } catch (error) {
    throw new PurchaseContractError(`invalid Purchase identity: ${error instanceof Error ? error.message : "invalid value"}`);
  }
}

function requireDigest(value: string, field: string): Sha256Digest {
  if (!DIGEST_PATTERN.test(value)) throw new PurchaseContractError(`${field} must be a canonical SHA-256 digest`);
  return value as Sha256Digest;
}

function requirePositiveDecimal(value: string, field: string): string {
  if (!POSITIVE_DECIMAL_PATTERN.test(value) || value.length > MAX_AMOUNT_DIGITS) {
    throw new PurchaseContractError(`${field} must be a canonical positive decimal integer`);
  }
  return value;
}

function requireNonNegativeDecimal(value: string, field: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || value.length > MAX_AMOUNT_DIGITS) {
    throw new PurchaseContractError(`${field} must be a canonical non-negative decimal integer`);
  }
  return value;
}

function requireBoundedIdentity(value: string, field: string, maximumLength: number): string {
  if (value.length === 0 || value.length > maximumLength || !BOUNDED_IDENTITY_PATTERN.test(value)) {
    throw new PurchaseContractError(`${field} must be a bounded canonical identity`);
  }
  return value;
}

function requireBoundedText(value: string, field: string, maximumLength: number): string {
  if (value.length === 0 || value.length > maximumLength || /[\u0000-\u001f\u007f]/.test(value) || value.trim() !== value) {
    throw new PurchaseContractError(`${field} must be bounded text without control or surrounding whitespace`);
  }
  return value;
}

function requireCanonicalOrigin(value: string, field: string): string {
  if (value.length === 0 || value.length > 256) throw new PurchaseContractError(`${field} is not a bounded origin`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PurchaseContractError(`${field} must be a valid origin`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    value !== url.origin
  ) {
    throw new PurchaseContractError(`${field} must be an exact canonical HTTP origin`);
  }
  return value;
}

function requireFutureRfc3339(value: string, now: () => number): string {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) throw new PurchaseContractError("Checkout Terms expiry must be strict RFC3339");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new PurchaseContractError("Checkout Terms expiry contains an invalid RFC3339 date or time");
  }
  const expiresAtMs = Date.parse(value);
  const nowMs = now();
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    throw new PurchaseContractError("Checkout Terms expiry or injected clock is invalid");
  }
  if (expiresAtMs <= nowMs) throw new PurchaseContractError("Checkout Terms expiry must be strictly in the future");
  return value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
