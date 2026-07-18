import type {
  JournalObservedStaging,
  JournalObservedStagingQuery,
  JournalObservedStagingSource,
} from "../adapters/kaspa-x402/exact-attempt-funding-bridge.js";
import type {
  TreasuryStagingFeeRequest,
  TreasuryStagingFeeSource,
} from "../adapters/kaspa-x402/chain-verifier.js";
import {
  CanonicalTreasuryStagingMetadataSource,
  TREASURY_STAGING_OBSERVATION_MEDIA_TYPE,
  TREASURY_STAGING_OBSERVATION_PROFILE,
  TREASURY_STAGING_OBSERVATION_VERIFIER_ID,
  decodeTreasuryStagingObservationEvidence,
  type TreasuryStagingMetadataSource,
} from "../adapters/kaspa-x402/vault-treasury-staging.js";
import { evidenceDigest } from "../purchase/identity.js";
import {
  PurchaseJournal,
  TREASURY_STAGING_EVIDENCE_KIND,
} from "../purchase/journal.js";
import type {
  PurchaseId,
  Sha256Digest,
} from "../purchase/types.js";

const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;

export class JournalSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JournalSourceError";
  }
}

/**
 * Builds the one canonical staging-envelope reader used by both exact
 * preparation and Settlement verification. Payment identifiers are resolved
 * through the journal rather than accepted as an untrusted attempt number.
 */
export function createJournalTreasuryStagingMetadataSource(
  journal: PurchaseJournal
): TreasuryStagingMetadataSource {
  requireJournal(journal);
  return new CanonicalTreasuryStagingMetadataSource({
    readPreparedEnvelope(query) {
      const attempt = requireAttempt(journal, query.purchaseId, query.paymentIdentifier);
      return journal.readPreparedTreasuryStaging(query.purchaseId, attempt);
    },
  });
}

/** Independently decodes and joins the journal's verified staging observation. */
export class JournalTreasuryStagingObservationSource
implements JournalObservedStagingSource {
  constructor(
    private readonly journal: PurchaseJournal,
    private readonly metadata: TreasuryStagingMetadataSource
  ) {
    requireJournal(journal);
    if (!metadata || typeof metadata.read !== "function") {
      throw new JournalSourceError("canonical staging metadata source is required");
    }
  }

  async read(
    query: Readonly<JournalObservedStagingQuery>
  ): Promise<JournalObservedStaging> {
    const attempt = requireAttempt(
      this.journal,
      query.purchaseId,
      query.paymentIdentifier
    );
    const observation = this.journal.findTreasuryStagingObservation(
      query.purchaseId,
      attempt
    );
    if (!observation || observation.evidenceDigest !== requireDigest(query.evidenceDigest)) {
      throw new JournalSourceError(
        "observed Treasury staging evidence is unavailable or differently bound"
      );
    }
    const attachment = this.journal.requireEvidenceAttachment(
      query.purchaseId,
      observation.evidenceDigest,
      TREASURY_STAGING_EVIDENCE_KIND,
      attempt
    );
    if (
      attachment.profile !== observation.evidenceVerificationProfile ||
      attachment.profile !== TREASURY_STAGING_OBSERVATION_PROFILE ||
      attachment.mediaType !== TREASURY_STAGING_OBSERVATION_MEDIA_TYPE ||
      attachment.issuer !== observation.evidenceVerifierId ||
      observation.evidenceVerifierId !== TREASURY_STAGING_OBSERVATION_VERIFIER_ID
    ) {
      throw new JournalSourceError("Treasury staging evidence metadata is inconsistent");
    }
    const bytes = Uint8Array.from(this.journal.readEvidence(observation.evidenceDigest));
    if (evidenceDigest(bytes) !== observation.evidenceDigest) {
      throw new JournalSourceError("Treasury staging evidence failed its content address");
    }
    const facts = decodeTreasuryStagingObservationEvidence(bytes, {
      purchaseId: query.purchaseId,
      paymentIdentifier: query.paymentIdentifier,
    });
    const metadata = await this.metadata.read({
      purchaseId: query.purchaseId,
      paymentIdentifier: query.paymentIdentifier,
    });
    const exact: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["profile", facts.profile, TREASURY_STAGING_OBSERVATION_PROFILE],
      ["Purchase", facts.purchaseId, query.purchaseId],
      ["payment identifier", facts.paymentIdentifier, query.paymentIdentifier],
      ["funding source", facts.fundingSource, "vault-treasury"],
      ["envelope", facts.envelopeDigest, metadata.envelopeDigest],
      ["transaction", facts.transactionId, observation.transactionId],
      ["transaction metadata", facts.transactionId, metadata.transactionId],
      ["outpoint", facts.stagingOutpoint, observation.outpoint],
      ["outpoint metadata", facts.stagingOutpoint, metadata.outpoint],
      ["amount", facts.stagingAmountAtomic, observation.stagingAmountAtomic],
      ["amount metadata", facts.stagingAmountAtomic, metadata.stagingAmountAtomic],
      ["fee", facts.stagingFeeAtomic, metadata.stagingFeeAtomic],
      ["key reference", facts.keyReference, metadata.keyReference],
      ["address", facts.stagingAddress, metadata.address],
      ["script", facts.stagingScriptPublicKey, metadata.scriptPublicKey],
    ];
    for (const [label, actual, expected] of exact) {
      if (actual !== expected) {
        throw new JournalSourceError(
          `Treasury staging observation ${label} differs from durable facts`
        );
      }
    }
    const blockDaaScore = atomic(facts.observedAtDaa, "observed staging DAA", true);
    return Object.freeze({
      purchaseId: query.purchaseId,
      paymentIdentifier: query.paymentIdentifier,
      transactionId: requireHash(facts.transactionId, "staging transaction ID"),
      outpoint: requireText(facts.stagingOutpoint, "staging outpoint"),
      amountAtomic: atomic(facts.stagingAmountAtomic, "staging amount", false),
      address: requireText(facts.stagingAddress, "staging address"),
      scriptPublicKey: requireHex(facts.stagingScriptPublicKey, "staging script"),
      blockDaaScore,
      evidenceDigest: observation.evidenceDigest,
    });
  }
}

/**
 * Narrow staging-fee source for the chain verifier. It joins the canonical
 * signed staging envelope to the independently decoded observed evidence.
 */
export class JournalChainTreasuryMetadataSource
implements TreasuryStagingFeeSource {
  private readonly now: () => number;

  constructor(
    private readonly metadata: TreasuryStagingMetadataSource,
    private readonly observed: JournalObservedStagingSource,
    now: () => number = Date.now
  ) {
    if (!metadata || typeof metadata.read !== "function") {
      throw new JournalSourceError("canonical staging metadata source is required");
    }
    if (!observed || typeof observed.read !== "function") {
      throw new JournalSourceError("observed staging source is required");
    }
    this.now = now;
    readClock(this.now);
  }

  async actualTransactionFeeAtomic(
    request: Readonly<TreasuryStagingFeeRequest>
  ): Promise<string | undefined> {
    request.signal.throwIfAborted();
    if (
      !Number.isSafeInteger(request.deadlineAtMs) ||
      request.deadlineAtMs <= readClock(this.now)
    ) {
      throw new JournalSourceError("Treasury staging metadata deadline expired");
    }
    const query = {
      purchaseId: request.purchaseId,
      paymentIdentifier: request.paymentIdentifier,
    } as const;
    const [metadata, observed] = await Promise.all([
      this.metadata.read(query),
      this.observed.read({ ...query, evidenceDigest: request.evidenceDigest }),
    ]);
    request.signal.throwIfAborted();
    if (readClock(this.now) >= request.deadlineAtMs) {
      throw new JournalSourceError("Treasury staging metadata deadline expired");
    }
    const exact: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["transaction", request.transactionId, observed.transactionId],
      ["transaction metadata", request.transactionId, metadata.transactionId],
      ["outpoint", request.outpoint, observed.outpoint],
      ["outpoint metadata", request.outpoint, metadata.outpoint],
      ["amount", request.amountAtomic, observed.amountAtomic],
      ["amount metadata", request.amountAtomic, metadata.stagingAmountAtomic],
      ["evidence", request.evidenceDigest, observed.evidenceDigest],
    ];
    for (const [label, actual, expected] of exact) {
      if (actual !== expected) {
        throw new JournalSourceError(
          `Treasury staging fee ${label} differs from durable facts`
        );
      }
    }
    return atomic(metadata.stagingFeeAtomic, "Treasury staging fee", true);
  }
}

function requireAttempt(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  paymentIdentifier: string
): number {
  const matches = journal
    .paymentAttempts(purchaseId)
    .filter((attempt) => attempt.identifier === paymentIdentifier);
  if (matches.length !== 1) {
    throw new JournalSourceError(
      "payment identifier does not select exactly one durable Payment Attempt"
    );
  }
  return matches[0].attempt;
}

function requireJournal(value: unknown): asserts value is PurchaseJournal {
  if (
    !value ||
    typeof (value as PurchaseJournal).paymentAttempts !== "function" ||
    typeof (value as PurchaseJournal).readEvidence !== "function"
  ) {
    throw new JournalSourceError("Purchase Journal is required");
  }
}

function requireText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new JournalSourceError(`${label} is invalid`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new JournalSourceError(`${label} is invalid`);
  }
  return value;
}

function requireHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{2})+$/.test(value)) {
    throw new JournalSourceError(`${label} is invalid`);
  }
  return value;
}

function requireDigest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new JournalSourceError("evidence digest is invalid");
  }
  return value as Sha256Digest;
}

function atomic(value: unknown, label: string, allowZero: boolean): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new JournalSourceError(`${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn || (!allowZero && parsed === 0n)) {
    throw new JournalSourceError(`${label} is outside uint64 bounds`);
  }
  return value;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new JournalSourceError("runtime clock is unavailable");
  }
  return value;
}
