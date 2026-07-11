import { SDJwtInstance } from "@sd-jwt/core";
import { Ap2AdapterError } from "./errors.js";
import {
  assertCompactJwt,
  assertExactKeys,
  assertShortLivedWindow,
  assertSigningIdentity,
  decodeBase64url,
  decodeBase64urlJson,
  requireArray,
  requireBase64urlDigest,
  requireBoundedText,
  requireRecord,
  resolveTrustedPublicKey,
  sha256Base64url,
  sha256Hasher,
  randomSalt,
  sdJwtSigner,
  sdJwtVerifier,
  verificationClock,
} from "./crypto.js";
import { loadPinnedAp2Schemas, type Ap2SchemaValidators } from "./schemas.js";
import {
  AP2_CHECKOUT_MANDATE_VCT,
  AP2_HUMAN_PRESENT_PROFILE,
  AP2_NATIVE_KAS_INSTRUMENT_PROFILE,
  AP2_PAYMENT_MANDATE_VCT,
  KASPA_TESTNET_NETWORK,
  KASPA_X402_SCHEME,
  KAS_ASSET,
  KAS_ATOMIC_UNIT,
  KAS_DECIMALS,
  type Ap2PublicKeyResolver,
  type Ap2SigningIdentity,
  type Ap2VerificationClock,
  type ClosedCheckoutMandateContent,
  type ClosedPaymentMandateContent,
  type VerifiedClosedCheckoutMandate,
  type VerifiedClosedPaymentMandate,
  type VerifiedHumanPresentMandates,
  type VerifiedMerchantCheckout,
} from "./types.js";

const MAX_ARTIFACT_BYTES = 64 * 1024;
const INSTRUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export interface IssueHumanPresentMandateOptions {
  readonly checkout: VerifiedMerchantCheckout;
  readonly instrumentId: string;
  readonly issuedAtSec: number;
  readonly expiresAtSec?: number;
}

export interface VerifyClosedMandateOptions extends Ap2VerificationClock {
  readonly trust: Ap2PublicKeyResolver;
  readonly expectedAuthorityIssuer: string;
  readonly checkout: VerifiedMerchantCheckout;
}

export interface VerifyClosedPaymentMandateOptions extends VerifyClosedMandateOptions {
  readonly expectedInstrumentId: string;
}

interface DirectRootResult<T extends object> {
  readonly content: T;
  readonly kid: string;
  readonly issuerJwtReference: string;
}

let validators: Ap2SchemaValidators | undefined;

export async function issueClosedCheckoutMandate(
  options: Omit<IssueHumanPresentMandateOptions, "instrumentId">,
  signer: Ap2SigningIdentity
): Promise<string> {
  assertSigningIdentity(signer, "authority");
  const times = mandateTimes(options.checkout, options.issuedAtSec, options.expiresAtSec);
  const content: ClosedCheckoutMandateContent = Object.freeze({
    vct: AP2_CHECKOUT_MANDATE_VCT,
    checkout_jwt: options.checkout.artifact,
    checkout_hash: options.checkout.checkoutHash,
    iat: times.iat,
    exp: times.exp,
  });
  assertCheckoutContent(content, options.checkout, { nowSec: times.iat, clockSkewSec: 0 });
  return issueDirectRoot(content, signer, true);
}

export async function issueClosedPaymentMandate(
  options: IssueHumanPresentMandateOptions,
  signer: Ap2SigningIdentity
): Promise<string> {
  assertSigningIdentity(signer, "authority");
  const times = mandateTimes(options.checkout, options.issuedAtSec, options.expiresAtSec);
  const instrumentId = requireInstrumentId(options.instrumentId);
  const amountAtomic = requireSafeKasAmount(options.checkout.terms.amountAtomic);
  const content: ClosedPaymentMandateContent = Object.freeze({
    vct: AP2_PAYMENT_MANDATE_VCT,
    transaction_id: options.checkout.checkoutHash,
    payee: Object.freeze({
      id: options.checkout.terms.merchant.id,
      name: options.checkout.terms.merchant.name,
      website: options.checkout.claims.merchant.website,
    }),
    payment_amount: Object.freeze({
      amount: Number(amountAtomic),
      currency: KAS_ASSET,
    }),
    payment_instrument: Object.freeze({
      id: instrumentId,
      type: AP2_NATIVE_KAS_INSTRUMENT_PROFILE,
      description: "Native KAS via Kaspa-x402 exact",
      network: KASPA_TESTNET_NETWORK,
      asset: KAS_ASSET,
      atomicUnit: KAS_ATOMIC_UNIT,
      decimals: KAS_DECIMALS,
      scheme: KASPA_X402_SCHEME,
    }),
    iat: times.iat,
    exp: times.exp,
  });
  assertPaymentContent(content, options.checkout, instrumentId, { nowSec: times.iat, clockSkewSec: 0 });
  return issueDirectRoot(content, signer, false);
}

export async function issueHumanPresentMandates(
  options: IssueHumanPresentMandateOptions,
  signer: Ap2SigningIdentity
): Promise<{ checkoutMandate: string; paymentMandate: string }> {
  const [checkoutMandate, paymentMandate] = await Promise.all([
    issueClosedCheckoutMandate(options, signer),
    issueClosedPaymentMandate(options, signer),
  ]);
  return Object.freeze({ checkoutMandate, paymentMandate });
}

export async function verifyClosedCheckoutMandate(
  artifact: string,
  options: VerifyClosedMandateOptions
): Promise<VerifiedClosedCheckoutMandate> {
  const verified = await verifyDirectRoot<ClosedCheckoutMandateContent>(
    artifact,
    options,
    "checkout"
  );
  const content = assertCheckoutContent(verified.content, options.checkout, options);
  return Object.freeze({
    artifact,
    profile: AP2_HUMAN_PRESENT_PROFILE,
    authorityIssuer: options.expectedAuthorityIssuer,
    kid: verified.kid,
    issuerJwtReference: verified.issuerJwtReference,
    content,
  });
}

export async function verifyClosedPaymentMandate(
  artifact: string,
  options: VerifyClosedPaymentMandateOptions
): Promise<VerifiedClosedPaymentMandate> {
  const verified = await verifyDirectRoot<ClosedPaymentMandateContent>(
    artifact,
    options,
    "payment"
  );
  const instrumentId = requireInstrumentId(options.expectedInstrumentId);
  const content = assertPaymentContent(verified.content, options.checkout, instrumentId, options);
  return Object.freeze({
    artifact,
    profile: AP2_HUMAN_PRESENT_PROFILE,
    authorityIssuer: options.expectedAuthorityIssuer,
    kid: verified.kid,
    issuerJwtReference: verified.issuerJwtReference,
    content,
    amountAtomic: String(content.payment_amount.amount),
    network: KASPA_TESTNET_NETWORK,
    asset: KAS_ASSET,
  });
}

export async function verifyHumanPresentMandates(
  artifacts: { readonly checkoutMandate: string; readonly paymentMandate: string },
  options: VerifyClosedPaymentMandateOptions
): Promise<VerifiedHumanPresentMandates> {
  const [checkout, payment] = await Promise.all([
    verifyClosedCheckoutMandate(artifacts.checkoutMandate, options),
    verifyClosedPaymentMandate(artifacts.paymentMandate, options),
  ]);
  if (
    checkout.kid !== payment.kid ||
    checkout.content.iat !== payment.content.iat ||
    checkout.content.exp !== payment.content.exp
  ) {
    throw new Ap2AdapterError(
      "Checkout and Payment Mandates did not come from one exact authority ceremony",
      "binding_mismatch"
    );
  }
  return Object.freeze({ checkout, payment });
}

async function issueDirectRoot<T extends object>(
  content: T,
  signer: Ap2SigningIdentity,
  discloseCheckoutJwt: boolean
): Promise<string> {
  const instance = new SDJwtInstance<Record<string, unknown>>({
    omitTyp: true,
    hashAlg: "sha-256",
    hasher: sha256Hasher,
    saltGenerator: randomSalt,
    signAlg: "ES256",
    signer: sdJwtSigner(signer),
  });
  const payload = { delegate_payload: [content] };
  const disclosureFrame = discloseCheckoutJwt
    ? {
        delegate_payload: {
          _sd: [0],
          0: { _sd: ["checkout_jwt"] },
        },
      }
    : { delegate_payload: { _sd: [0] } };
  try {
    const issued = await instance.issue(payload, disclosureFrame as never, {
      header: { kid: signer.kid },
    });
    // Make the fully disclosed direct presentation explicit and reject library drift.
    assertDirectRootStructure(issued, discloseCheckoutJwt ? "checkout" : "payment");
    return issued;
  } catch (error) {
    if (error instanceof Ap2AdapterError) throw error;
    throw new Ap2AdapterError("closed AP2 mandate issuance failed", "signature_invalid");
  }
}

async function verifyDirectRoot<T extends object>(
  artifact: string,
  options: VerifyClosedMandateOptions,
  kind: "checkout" | "payment"
): Promise<DirectRootResult<T>> {
  const structure = assertDirectRootStructure(artifact, kind);
  const { jwk } = await resolveTrustedPublicKey({
    resolver: options.trust,
    role: "authority",
    issuer: options.expectedAuthorityIssuer,
    kid: structure.kid,
  });
  const instance = new SDJwtInstance<Record<string, unknown>>({
    hashAlg: "sha-256",
    hasher: sha256Hasher,
    verifier: sdJwtVerifier(jwk),
  });
  let result: Awaited<ReturnType<typeof instance.verify>>;
  try {
    const { nowSec, clockSkewSec } = verificationClock(options);
    result = await instance.verify(artifact, { currentDate: nowSec, skewSeconds: clockSkewSec });
  } catch {
    throw new Ap2AdapterError("closed AP2 mandate signature is invalid", "signature_invalid");
  }
  if (!result.header) {
    throw new Ap2AdapterError("closed AP2 mandate protected header is missing", "artifact_malformed");
  }
  const resolved = requireRecord(result.payload, "closed AP2 mandate payload");
  assertExactKeys(resolved, ["delegate_payload"], ["delegate_payload"], "closed AP2 mandate payload");
  const delegates = requireArray(resolved.delegate_payload, "closed AP2 mandate delegate_payload");
  if (delegates.length !== 1) {
    throw new Ap2AdapterError("closed AP2 mandate must reveal exactly one delegate payload", "profile_mismatch");
  }
  const content = requireRecord(delegates[0], "closed AP2 mandate content") as unknown as T;
  return {
    content,
    kid: structure.kid,
    issuerJwtReference: sha256Base64url(Buffer.from(structure.issuerJwt, "ascii")),
  };
}

function assertDirectRootStructure(
  artifact: string,
  kind: "checkout" | "payment"
): { issuerJwt: string; kid: string } {
  if (
    typeof artifact !== "string" ||
    artifact.length === 0 ||
    Buffer.byteLength(artifact, "utf8") > MAX_ARTIFACT_BYTES ||
    /[^\x21-\x7e]/.test(artifact) ||
    artifact.includes("~~")
  ) {
    throw new Ap2AdapterError("mandate is not a bounded direct compact SD-JWT", "artifact_malformed");
  }
  const segments = artifact.split("~");
  const expectedDisclosureCount = kind === "checkout" ? 2 : 1;
  if (
    segments.length !== expectedDisclosureCount + 2 ||
    segments.at(-1) !== "" ||
    segments.slice(1, -1).some((segment) => segment.length === 0)
  ) {
    throw new Ap2AdapterError(
      "mandate must be one fully disclosed root SD-JWT without a chain or KB-JWT",
      "profile_mismatch"
    );
  }
  const issuerJwt = segments[0];
  assertCompactJwt(issuerJwt);
  const jwtParts = issuerJwt.split(".");
  const headerValue = requireRecord(decodeBase64urlJson(jwtParts[0], "mandate protected header"), "mandate protected header");
  assertExactKeys(headerValue, ["alg", "kid"], ["alg", "kid"], "mandate protected header");
  if (headerValue.alg !== "ES256") {
    throw new Ap2AdapterError("mandate algorithm is outside the pinned profile", "profile_mismatch");
  }
  const kid = requireBoundedText(headerValue.kid, "mandate kid", 160);

  const rawPayload = requireRecord(decodeBase64urlJson(jwtParts[1], "mandate issuer payload"), "mandate issuer payload");
  assertExactKeys(
    rawPayload,
    ["delegate_payload", "_sd_alg"],
    ["delegate_payload", "_sd_alg"],
    "mandate issuer payload"
  );
  if (rawPayload._sd_alg !== "sha-256") {
    throw new Ap2AdapterError("mandate disclosure hash is outside the pinned profile", "profile_mismatch");
  }
  const rawDelegates = requireArray(rawPayload.delegate_payload, "mandate raw delegate_payload");
  if (rawDelegates.length !== 1) {
    throw new Ap2AdapterError("mandate raw delegate_payload must contain one commitment", "profile_mismatch");
  }
  const commitment = requireRecord(rawDelegates[0], "mandate delegate commitment");
  assertExactKeys(commitment, ["..."], ["..."], "mandate delegate commitment");
  const outerDigest = requireBase64urlDigest(commitment["..."], "mandate delegate digest");

  const disclosures = segments.slice(1, -1);
  const decoded = disclosures.map((encoded, index) => ({
    encoded,
    digest: sha256Base64url(Buffer.from(encoded, "ascii")),
    value: requireArray(decodeBase64urlJson(encoded, `mandate disclosure ${index + 1}`), `mandate disclosure ${index + 1}`),
  }));
  for (const disclosure of decoded) assertDisclosureSalt(disclosure.value);
  const outer = decoded.find((item) => item.value.length === 2);
  if (!outer || outer.digest !== outerDigest) {
    throw new Ap2AdapterError("mandate delegate disclosure does not match its commitment", "binding_mismatch");
  }
  const outerContent = requireRecord(outer.value[1], "mandate disclosed delegate content");
  if (kind === "payment") {
    if (decoded.length !== 1 || Object.prototype.hasOwnProperty.call(outerContent, "_sd")) {
      throw new Ap2AdapterError("Payment Mandate contains unexpected selective disclosures", "profile_mismatch");
    }
  } else {
    const nestedDigests = requireArray(outerContent._sd, "Checkout Mandate nested disclosure digests");
    assertExactKeys(
      outerContent,
      ["_sd", "vct", "checkout_hash", "iat", "exp"],
      ["_sd", "vct", "checkout_hash", "iat", "exp"],
      "Checkout Mandate disclosed delegate content"
    );
    if (nestedDigests.length !== 1) {
      throw new Ap2AdapterError("Checkout Mandate must disclose checkout_jwt exactly once", "profile_mismatch");
    }
    const nestedDigest = requireBase64urlDigest(nestedDigests[0], "Checkout Mandate checkout_jwt digest");
    const nested = decoded.find((item) => item.value.length === 3);
    if (
      !nested ||
      nested.digest !== nestedDigest ||
      nested.value[1] !== "checkout_jwt" ||
      typeof nested.value[2] !== "string"
    ) {
      throw new Ap2AdapterError("Checkout Mandate checkout_jwt disclosure is misbound", "binding_mismatch");
    }
  }
  return { issuerJwt, kid };
}

function assertCheckoutContent(
  candidate: unknown,
  checkout: VerifiedMerchantCheckout,
  clock: Ap2VerificationClock
): ClosedCheckoutMandateContent {
  const value = requireRecord(candidate, "Checkout Mandate content");
  assertExactKeys(
    value,
    ["vct", "checkout_jwt", "checkout_hash", "iat", "exp"],
    ["vct", "checkout_jwt", "checkout_hash", "iat", "exp"],
    "Checkout Mandate content"
  );
  if (!schemaValidators().checkoutMandate(value)) {
    throw new Ap2AdapterError("Checkout Mandate fails the pinned AP2 schema", "schema_invalid");
  }
  if (value.vct !== AP2_CHECKOUT_MANDATE_VCT) {
    throw new Ap2AdapterError("Checkout Mandate VCT is unsupported", "profile_mismatch");
  }
  if (value.checkout_jwt !== checkout.artifact) {
    throw new Ap2AdapterError("Checkout Mandate contains different Merchant Checkout bytes", "binding_mismatch");
  }
  const checkoutHash = requireBase64urlDigest(value.checkout_hash, "Checkout Mandate checkout_hash");
  if (
    checkoutHash !== checkout.checkoutHash ||
    checkoutHash !== sha256Base64url(Buffer.from(value.checkout_jwt as string, "utf8"))
  ) {
    throw new Ap2AdapterError("Checkout Mandate checkout_hash does not match exact Checkout bytes", "binding_mismatch");
  }
  const times = assertMandateTimes(value.iat, value.exp, checkout, clock);
  return Object.freeze({
    vct: AP2_CHECKOUT_MANDATE_VCT,
    checkout_jwt: checkout.artifact,
    checkout_hash: checkoutHash,
    iat: times.iat,
    exp: times.exp,
  });
}

function assertPaymentContent(
  candidate: unknown,
  checkout: VerifiedMerchantCheckout,
  expectedInstrumentId: string,
  clock: Ap2VerificationClock
): ClosedPaymentMandateContent {
  const value = requireRecord(candidate, "Payment Mandate content");
  assertExactKeys(
    value,
    ["vct", "transaction_id", "payee", "payment_amount", "payment_instrument", "iat", "exp"],
    ["vct", "transaction_id", "payee", "payment_amount", "payment_instrument", "iat", "exp"],
    "Payment Mandate content"
  );
  if (!schemaValidators().paymentMandate(value)) {
    throw new Ap2AdapterError("Payment Mandate fails the pinned AP2 schema", "schema_invalid");
  }
  if (value.vct !== AP2_PAYMENT_MANDATE_VCT || value.transaction_id !== checkout.checkoutHash) {
    throw new Ap2AdapterError("Payment Mandate is not bound to the exact Checkout", "binding_mismatch");
  }
  const payee = requireRecord(value.payee, "Payment Mandate payee");
  assertExactKeys(payee, ["id", "name", "website"], ["id", "name", "website"], "Payment Mandate payee");
  if (
    payee.id !== checkout.terms.merchant.id ||
    payee.name !== checkout.terms.merchant.name ||
    payee.website !== checkout.claims.merchant.website
  ) {
    throw new Ap2AdapterError("Payment Mandate payee does not match the Checkout Merchant", "binding_mismatch");
  }

  const amount = requireRecord(value.payment_amount, "Payment Mandate amount");
  assertExactKeys(amount, ["amount", "currency"], ["amount", "currency"], "Payment Mandate amount");
  if (
    !Number.isSafeInteger(amount.amount) ||
    (amount.amount as number) <= 0 ||
    amount.currency !== KAS_ASSET ||
    String(amount.amount) !== checkout.terms.amountAtomic
  ) {
    throw new Ap2AdapterError("Payment Mandate amount does not match exact native KAS terms", "binding_mismatch");
  }

  const instrument = requireRecord(value.payment_instrument, "Payment Mandate instrument");
  assertExactKeys(
    instrument,
    ["id", "type", "description", "network", "asset", "atomicUnit", "decimals", "scheme"],
    ["id", "type", "description", "network", "asset", "atomicUnit", "decimals", "scheme"],
    "Payment Mandate instrument"
  );
  if (
    instrument.id !== expectedInstrumentId ||
    instrument.type !== AP2_NATIVE_KAS_INSTRUMENT_PROFILE ||
    instrument.description !== "Native KAS via Kaspa-x402 exact" ||
    instrument.network !== KASPA_TESTNET_NETWORK ||
    instrument.asset !== KAS_ASSET ||
    instrument.atomicUnit !== KAS_ATOMIC_UNIT ||
    instrument.decimals !== KAS_DECIMALS ||
    instrument.scheme !== KASPA_X402_SCHEME
  ) {
    throw new Ap2AdapterError("Payment Mandate instrument is outside the native-KAS testnet profile", "profile_mismatch");
  }
  if (
    checkout.terms.asset !== KAS_ASSET ||
    checkout.terms.network !== KASPA_TESTNET_NETWORK
  ) {
    throw new Ap2AdapterError("Checkout terms are outside the native-KAS testnet profile", "profile_mismatch");
  }

  const times = assertMandateTimes(value.iat, value.exp, checkout, clock);
  return Object.freeze({
    vct: AP2_PAYMENT_MANDATE_VCT,
    transaction_id: checkout.checkoutHash,
    payee: Object.freeze({
      id: payee.id as string,
      name: payee.name as string,
      website: payee.website as string,
    }),
    payment_amount: Object.freeze({ amount: amount.amount as number, currency: KAS_ASSET }),
    payment_instrument: Object.freeze({
      id: instrument.id as string,
      type: AP2_NATIVE_KAS_INSTRUMENT_PROFILE,
      description: "Native KAS via Kaspa-x402 exact",
      network: KASPA_TESTNET_NETWORK,
      asset: KAS_ASSET,
      atomicUnit: KAS_ATOMIC_UNIT,
      decimals: KAS_DECIMALS,
      scheme: KASPA_X402_SCHEME,
    }),
    iat: times.iat,
    exp: times.exp,
  });
}

function assertMandateTimes(
  iat: unknown,
  exp: unknown,
  checkout: VerifiedMerchantCheckout,
  clock: Ap2VerificationClock
): { iat: number; exp: number } {
  const times = assertShortLivedWindow(iat, exp, clock);
  const { clockSkewSec } = verificationClock(clock);
  if (times.iat < checkout.issuedAtSec - clockSkewSec || times.exp > checkout.expiresAtSec) {
    throw new Ap2AdapterError("mandate time window is outside the signed Checkout window", "time_invalid");
  }
  return times;
}

function mandateTimes(
  checkout: VerifiedMerchantCheckout,
  issuedAtSec: number,
  expiresAtSec = checkout.expiresAtSec
): { iat: number; exp: number } {
  return assertMandateTimes(issuedAtSec, expiresAtSec, checkout, {
    nowSec: issuedAtSec,
    clockSkewSec: 0,
  });
}

function requireInstrumentId(value: unknown): string {
  if (typeof value !== "string" || !INSTRUMENT_ID_PATTERN.test(value)) {
    throw new Ap2AdapterError("Payment Instrument ID is not a bounded identity", "profile_mismatch");
  }
  return value;
}

function requireSafeKasAmount(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 16 || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Ap2AdapterError("native KAS amount exceeds the JSON safe-integer profile", "profile_mismatch");
  }
  return value;
}

function assertDisclosureSalt(disclosure: unknown[]): void {
  if (disclosure.length !== 2 && disclosure.length !== 3) {
    throw new Ap2AdapterError("mandate disclosure has an unsupported shape", "profile_mismatch");
  }
  if (typeof disclosure[0] !== "string" || decodeBase64url(disclosure[0], "mandate disclosure salt").byteLength < 16) {
    throw new Ap2AdapterError("mandate disclosure salt has insufficient entropy", "profile_mismatch");
  }
}

function schemaValidators(): Ap2SchemaValidators {
  validators ??= loadPinnedAp2Schemas();
  return validators;
}
