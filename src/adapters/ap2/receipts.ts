import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { Ap2AdapterError } from "./errors.js";
import {
  assertCompactJwt,
  assertExactKeys,
  assertSigningIdentity,
  importSigningKey,
  requireBase64urlDigest,
  requireBoundedText,
  requireRecord,
  requireSafeEpoch,
  resolveTrustedPublicKey,
  strictProtectedHeader,
  verificationClock,
} from "./crypto.js";
import { loadPinnedAp2Schemas, type Ap2SchemaValidators } from "./schemas.js";
import {
  SOMPI_MERCHANT_RECEIPT_PROFILE,
  SOMPI_PAYMENT_RECEIPT_PROFILE,
  type Ap2PublicKeyResolver,
  type Ap2SigningIdentity,
  type Ap2VerificationClock,
  type VerifiedAp2Receipt,
  type VerifiedClosedCheckoutMandate,
  type VerifiedClosedPaymentMandate,
} from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
let validators: Ap2SchemaValidators | undefined;

export type CheckoutReceiptInput =
  | {
      readonly status: "Success";
      readonly mandate: VerifiedClosedCheckoutMandate;
      readonly orderId: string;
      readonly issuedAtSec: number;
    }
  | {
      readonly status: "Error";
      readonly mandate: VerifiedClosedCheckoutMandate;
      readonly error: string;
      readonly errorDescription: string;
      readonly issuedAtSec: number;
    };

export type PaymentReceiptInput =
  | {
      readonly status: "Success";
      readonly mandate: VerifiedClosedPaymentMandate;
      readonly paymentId: string;
      readonly pspConfirmationId: string;
      readonly networkConfirmationId: string;
      readonly issuedAtSec: number;
    }
  | {
      readonly status: "Error";
      readonly mandate: VerifiedClosedPaymentMandate;
      readonly paymentId: string;
      readonly error: string;
      readonly errorDescription: string;
      readonly issuedAtSec: number;
    };

export interface VerifyCheckoutReceiptOptions extends Ap2VerificationClock {
  readonly trust: Ap2PublicKeyResolver;
  readonly expectedIssuer: string;
  readonly mandate: VerifiedClosedCheckoutMandate;
}

export interface VerifyPaymentReceiptOptions extends Ap2VerificationClock {
  readonly trust: Ap2PublicKeyResolver;
  readonly expectedIssuer: string;
  readonly mandate: VerifiedClosedPaymentMandate;
  readonly expectedPaymentId: string;
}

export async function issueCheckoutReceipt(
  input: CheckoutReceiptInput,
  signer: Ap2SigningIdentity
): Promise<string> {
  assertSigningIdentity(signer, "merchant-receipt");
  const iat = requireSafeEpoch(input.issuedAtSec, "Checkout Receipt iat");
  const base = {
    status: input.status,
    iss: signer.issuer,
    iat,
    reference: input.mandate.issuerJwtReference,
  };
  const payload = input.status === "Success"
    ? { ...base, order_id: requireReceiptId(input.orderId, "Checkout Receipt order ID") }
    : {
        ...base,
        error: requireReceiptId(input.error, "Checkout Receipt error"),
        error_description: requireBoundedText(
          input.errorDescription,
          "Checkout Receipt error description",
          1024
        ),
      };
  assertCheckoutReceiptPayload(payload, signer.issuer, input.mandate.issuerJwtReference, {
    nowSec: iat,
    clockSkewSec: 0,
  });
  return signReceipt(payload, signer);
}

export async function issuePaymentReceipt(
  input: PaymentReceiptInput,
  signer: Ap2SigningIdentity
): Promise<string> {
  assertSigningIdentity(signer, "payment-receipt");
  const iat = requireSafeEpoch(input.issuedAtSec, "Payment Receipt iat");
  const base = {
    status: input.status,
    iss: signer.issuer,
    iat,
    reference: input.mandate.issuerJwtReference,
    payment_id: requireReceiptId(input.paymentId, "Payment Receipt payment ID"),
  };
  const payload = input.status === "Success"
    ? {
        ...base,
        psp_confirmation_id: requireReceiptId(
          input.pspConfirmationId,
          "Payment Receipt PSP confirmation ID"
        ),
        network_confirmation_id: requireReceiptId(
          input.networkConfirmationId,
          "Payment Receipt network confirmation ID"
        ),
      }
    : {
        ...base,
        error: requireReceiptId(input.error, "Payment Receipt error"),
        error_description: requireBoundedText(
          input.errorDescription,
          "Payment Receipt error description",
          1024
        ),
      };
  assertPaymentReceiptPayload(payload, signer.issuer, input.mandate.issuerJwtReference, base.payment_id, {
    nowSec: iat,
    clockSkewSec: 0,
  });
  return signReceipt(payload, signer);
}

export async function verifyCheckoutReceipt(
  artifact: string,
  options: VerifyCheckoutReceiptOptions
): Promise<VerifiedAp2Receipt> {
  const { payload, kid } = await verifyReceiptJwt(
    artifact,
    "merchant-receipt",
    options.expectedIssuer,
    options.trust,
    options
  );
  const receipt = assertCheckoutReceiptPayload(
    payload,
    options.expectedIssuer,
    options.mandate.issuerJwtReference,
    options
  );
  return Object.freeze({
    artifact,
    role: "merchant",
    profile: SOMPI_MERCHANT_RECEIPT_PROFILE,
    issuer: receipt.iss,
    kid,
    status: receipt.status,
    issuedAtSec: receipt.iat,
    reference: receipt.reference,
    ...(receipt.status === "Success"
      ? { orderId: receipt.order_id }
      : { error: receipt.error, errorDescription: receipt.error_description }),
  });
}

export async function verifyPaymentReceipt(
  artifact: string,
  options: VerifyPaymentReceiptOptions
): Promise<VerifiedAp2Receipt> {
  const expectedPaymentId = requireReceiptId(options.expectedPaymentId, "expected Payment Receipt payment ID");
  const { payload, kid } = await verifyReceiptJwt(
    artifact,
    "payment-receipt",
    options.expectedIssuer,
    options.trust,
    options
  );
  const receipt = assertPaymentReceiptPayload(
    payload,
    options.expectedIssuer,
    options.mandate.issuerJwtReference,
    expectedPaymentId,
    options
  );
  return Object.freeze({
    artifact,
    role: "payment",
    profile: SOMPI_PAYMENT_RECEIPT_PROFILE,
    issuer: receipt.iss,
    kid,
    status: receipt.status,
    issuedAtSec: receipt.iat,
    reference: receipt.reference,
    paymentId: receipt.payment_id,
    ...(receipt.status === "Success"
      ? {
          pspConfirmationId: receipt.psp_confirmation_id,
          networkConfirmationId: receipt.network_confirmation_id,
        }
      : { error: receipt.error, errorDescription: receipt.error_description }),
  });
}

async function signReceipt(payload: Record<string, unknown>, signer: Ap2SigningIdentity): Promise<string> {
  const key = await importSigningKey(signer);
  try {
    return await new SignJWT(payload as JWTPayload)
      .setProtectedHeader({ alg: "ES256", kid: signer.kid, typ: "JWT" })
      .sign(key);
  } catch {
    throw new Ap2AdapterError("AP2 Receipt signing failed", "signature_invalid");
  }
}

async function verifyReceiptJwt(
  artifact: string,
  role: "merchant-receipt" | "payment-receipt",
  expectedIssuer: string,
  trust: Ap2PublicKeyResolver,
  clock: Ap2VerificationClock
): Promise<{ payload: Record<string, unknown>; kid: string }> {
  assertCompactJwt(artifact);
  const header = await strictProtectedHeader(artifact, ["alg", "kid", "typ"], "JWT");
  const { key } = await resolveTrustedPublicKey({
    resolver: trust,
    role,
    issuer: expectedIssuer,
    kid: header.kid,
  });
  const { nowSec, clockSkewSec } = verificationClock(clock);
  try {
    const verified = await jwtVerify(artifact, key, {
      algorithms: ["ES256"],
      issuer: expectedIssuer,
      currentDate: new Date(nowSec * 1000),
      clockTolerance: clockSkewSec,
    });
    return { payload: verified.payload, kid: header.kid };
  } catch {
    throw new Ap2AdapterError("AP2 Receipt signature or issuer is invalid", "signature_invalid");
  }
}

type CheckoutReceiptPayload =
  | { status: "Success"; iss: string; iat: number; reference: string; order_id: string }
  | {
      status: "Error";
      iss: string;
      iat: number;
      reference: string;
      error: string;
      error_description: string;
    };

function assertCheckoutReceiptPayload(
  candidate: unknown,
  expectedIssuer: string,
  expectedReference: string,
  clock: Ap2VerificationClock
): CheckoutReceiptPayload {
  const value = requireRecord(candidate, "Checkout Receipt payload");
  if (!schemaValidators().checkoutReceipt(value)) {
    throw new Ap2AdapterError("Checkout Receipt fails the pinned AP2 schema", "schema_invalid");
  }
  const status = requireStatus(value.status, "Checkout Receipt");
  const required = status === "Success"
    ? ["status", "iss", "iat", "reference", "order_id"]
    : ["status", "iss", "iat", "reference", "error", "error_description"];
  assertExactKeys(value, required, required, "Checkout Receipt payload");
  const base = receiptBase(value, expectedIssuer, expectedReference, clock);
  return status === "Success"
    ? Object.freeze({
        status,
        ...base,
        order_id: requireReceiptId(value.order_id, "Checkout Receipt order ID"),
      })
    : Object.freeze({
        status,
        ...base,
        error: requireReceiptId(value.error, "Checkout Receipt error"),
        error_description: requireBoundedText(
          value.error_description,
          "Checkout Receipt error description",
          1024
        ),
      });
}

type PaymentReceiptPayload =
  | {
      status: "Success";
      iss: string;
      iat: number;
      reference: string;
      payment_id: string;
      psp_confirmation_id: string;
      network_confirmation_id: string;
    }
  | {
      status: "Error";
      iss: string;
      iat: number;
      reference: string;
      payment_id: string;
      error: string;
      error_description: string;
    };

function assertPaymentReceiptPayload(
  candidate: unknown,
  expectedIssuer: string,
  expectedReference: string,
  expectedPaymentId: string,
  clock: Ap2VerificationClock
): PaymentReceiptPayload {
  const value = requireRecord(candidate, "Payment Receipt payload");
  if (!schemaValidators().paymentReceipt(value)) {
    throw new Ap2AdapterError("Payment Receipt fails the pinned AP2 schema", "schema_invalid");
  }
  const status = requireStatus(value.status, "Payment Receipt");
  const required = status === "Success"
    ? [
        "status", "iss", "iat", "reference", "payment_id",
        "psp_confirmation_id", "network_confirmation_id",
      ]
    : ["status", "iss", "iat", "reference", "payment_id", "error", "error_description"];
  assertExactKeys(value, required, required, "Payment Receipt payload");
  const base = receiptBase(value, expectedIssuer, expectedReference, clock);
  const paymentId = requireReceiptId(value.payment_id, "Payment Receipt payment ID");
  if (paymentId !== expectedPaymentId) {
    throw new Ap2AdapterError("Payment Receipt payment ID does not match", "binding_mismatch");
  }
  return status === "Success"
    ? Object.freeze({
        status,
        ...base,
        payment_id: paymentId,
        psp_confirmation_id: requireReceiptId(
          value.psp_confirmation_id,
          "Payment Receipt PSP confirmation ID"
        ),
        network_confirmation_id: requireReceiptId(
          value.network_confirmation_id,
          "Payment Receipt network confirmation ID"
        ),
      })
    : Object.freeze({
        status,
        ...base,
        payment_id: paymentId,
        error: requireReceiptId(value.error, "Payment Receipt error"),
        error_description: requireBoundedText(
          value.error_description,
          "Payment Receipt error description",
          1024
        ),
      });
}

function receiptBase(
  value: Record<string, unknown>,
  expectedIssuer: string,
  expectedReference: string,
  clock: Ap2VerificationClock
): { iss: string; iat: number; reference: string } {
  const iss = requireBoundedText(value.iss, "AP2 Receipt issuer", 256);
  if (iss !== expectedIssuer) {
    throw new Ap2AdapterError("AP2 Receipt issuer does not match", "binding_mismatch");
  }
  const iat = requireSafeEpoch(value.iat, "AP2 Receipt iat");
  const { nowSec, clockSkewSec } = verificationClock(clock);
  if (iat > nowSec + clockSkewSec) {
    throw new Ap2AdapterError("AP2 Receipt was issued in the future", "time_invalid");
  }
  const reference = requireBase64urlDigest(value.reference, "AP2 Receipt reference");
  if (reference !== expectedReference) {
    throw new Ap2AdapterError(
      "AP2 Receipt reference does not match the pinned issuer-JWT-segment rule",
      "binding_mismatch"
    );
  }
  return { iss, iat, reference };
}

function requireStatus(value: unknown, label: string): "Success" | "Error" {
  if (value !== "Success" && value !== "Error") {
    throw new Ap2AdapterError(`${label} status is unsupported`, "profile_mismatch");
  }
  return value;
}

function requireReceiptId(value: unknown, label: string): string {
  const text = requireBoundedText(value, label, 256);
  if (!ID_PATTERN.test(text)) {
    throw new Ap2AdapterError(`${label} is not a bounded identifier`, "profile_mismatch");
  }
  return text;
}

function schemaValidators(): Ap2SchemaValidators {
  validators ??= loadPinnedAp2Schemas();
  return validators;
}
