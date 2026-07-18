import { parsePaymentRequiredHeaderValue } from "@kaspa-x402/client";

import type {
  AuthorityCheckoutEvidenceVerificationInput,
  AuthorityCheckoutEvidenceVerifier,
  AuthorityApprovalFacts,
} from "../../authority/protocol.js";
import { evidenceDigest } from "../../purchase/identity.js";
import { KASPA_X402_PAYMENT_REQUIRED_PROFILE } from "./payment-requirements-verifier.js";

const TESTNET = "kaspa:testnet-10";
const MEDIA_TYPE = "application/x402-payment-required";
const MAX_TIMEOUT_SECONDS = 86_400;

/** Authority-side, store-independent verification of the exact x402 offer shown to the user. */
export class KaspaX402AuthorityEvidenceVerifier
implements AuthorityCheckoutEvidenceVerifier {
  async verify(input: AuthorityCheckoutEvidenceVerificationInput): Promise<void> {
    const { evidence, facts } = input;
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) {
      throw new Error("authority verification clock is invalid");
    }
    const bytes = strictAscii(evidence.artifact);
    if (
      evidence.digest !== evidenceDigest(bytes) ||
      evidence.digest !== facts.checkoutDigest ||
      evidence.mediaType !== MEDIA_TYPE ||
      evidence.profile !== KASPA_X402_PAYMENT_REQUIRED_PROFILE ||
      evidence.issuer !== facts.merchantId ||
      evidence.issuer !== facts.merchantOrigin
    ) {
      throw new Error("x402 checkout evidence metadata does not match the authority facts");
    }

    const parsed = parsePaymentRequiredHeaderValue(evidence.artifact, {
      supportedNetworks: [TESTNET],
      supportedSchemes: ["exact", "batch-settlement"],
    });
    if (parsed.paymentRequired.accepts.length !== 1) {
      throw new Error("x402 checkout evidence must contain exactly one offer");
    }
    const accepted = parsed.accepted;
    const target = new URL(parsed.paymentRequired.resource.url);
    if (
      target.href !== facts.resourceUrl ||
      target.origin !== facts.merchantOrigin ||
      accepted.amount !== facts.amountAtomic ||
      accepted.asset !== facts.asset ||
      accepted.network !== facts.network ||
      accepted.payTo !== facts.payTo
    ) {
      throw new Error("x402 checkout evidence is bound to different purchase facts");
    }
    if (
      !Number.isSafeInteger(accepted.maxTimeoutSeconds) ||
      accepted.maxTimeoutSeconds <= 0 ||
      accepted.maxTimeoutSeconds > MAX_TIMEOUT_SECONDS
    ) {
      throw new Error("x402 checkout timeout is invalid");
    }
    assertExecutionProfile(accepted, facts);

    const termsExpiryMs = Date.parse(facts.termsExpiresAt);
    const maximumExpiryMs = input.nowMs + accepted.maxTimeoutSeconds * 1_000;
    if (!Number.isFinite(termsExpiryMs) || termsExpiryMs <= input.nowMs || termsExpiryMs > maximumExpiryMs) {
      throw new Error("x402 checkout expiry does not match the authority facts");
    }
    if (accepted.scheme === "exact" && accepted.extra.profile === "additive") {
      const challengeExpiryMs = Date.parse(String(accepted.extra.challengeExpiresAt ?? ""));
      if (!Number.isFinite(challengeExpiryMs) || termsExpiryMs > challengeExpiryMs) {
        throw new Error("additive checkout exceeds its head challenge lifetime");
      }
    }
  }
}

function assertExecutionProfile(
  accepted: ReturnType<typeof parsePaymentRequiredHeaderValue>["accepted"],
  facts: AuthorityApprovalFacts,
): void {
  if (accepted.scheme === "exact") {
    const profile = accepted.extra.profile;
    if (
      accepted.extra.binding !== "kaspa-exact-v2" ||
      (profile !== "standard-native" && profile !== "additive") ||
      facts.executionMechanism !== "single-transaction" ||
      facts.executionProfile !== `kaspa-exact-v2:${profile}` ||
      facts.maximumAuthorizedChargeAtomic !== accepted.amount ||
      facts.settlementAssurance !== accepted.extra.finality ||
      facts.channelId !== null ||
      facts.channelEpochDigest !== null
    ) {
      throw new Error("x402 exact offer does not match the authorized execution plan");
    }
    return;
  }
  if (
    accepted.extra.binding !== "kaspa-escrow-v1" ||
    accepted.extra.templateId !== "kaspa-x402-escrow-v1" ||
    facts.executionMechanism !== "channel-voucher" ||
    facts.executionProfile !== "kaspa-escrow-v1:batch-settlement" ||
    facts.maximumAuthorizedChargeAtomic !== accepted.amount ||
    facts.settlementAssurance !== "channel-commitment" ||
    facts.channelId === null ||
    facts.channelEpochDigest === null
  ) {
    throw new Error("x402 batch offer does not match the authorized execution plan");
  }
}

function strictAscii(value: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "ascii") > 32 * 1024 || /[^\x21-\x7e]/.test(value)) {
    throw new Error("x402 checkout evidence is not bounded compact ASCII");
  }
  return Uint8Array.from(Buffer.from(value, "ascii"));
}
