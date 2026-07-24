import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import Database from "better-sqlite3";
import { SignJWT, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";

import {
  ownerAuthorityApprovalDisplay,
  type AuthorityApprovalPrompt,
} from "./approval-ceremony.js";
import type { Ap2PublicKeyResolver, Ap2SigningIdentity } from "../adapters/ap2/types.js";
import { importSigningKey, resolveTrustedPublicKey } from "../adapters/ap2/crypto.js";
import type { AuthorityAuthenticationProvider } from "./key-provider.js";
import type { AuthorityAuthenticationInput } from "./protocol.js";
import {
  AuthorityPromptAdmission,
  AuthorityPromptAdmissionError,
} from "./prompt-admission.js";
import type { AuthorityDecisionTransport } from "../adapters/ap2/authority-module.js";
import type { TransferAuthorizationFacts, TransferAuthorityModule } from "../transfer/types.js";
import type {
  PolicyChangeAuthorityModule,
  PolicyChangeFacts,
} from "../policy-change/types.js";
import type { VaultMigrationAuthorityModule, VaultMigrationFacts } from "../vault-migration/types.js";
import type { Sha256Digest } from "../purchase/types.js";

export const OWNER_AUTHORITY_REQUEST_PROFILE = "sompi.owner-authority.request.1" as const;
export const OWNER_AUTHORITY_RESPONSE_PROFILE = "sompi.owner-authority.response.1" as const;
export const OWNER_AUTHORITY_EVIDENCE_PROFILE = "urn:sompi:authority-decision:owner:1" as const;
export const OWNER_AUTHORITY_AUDIENCE = "urn:sompi:owner-authority-verifier" as const;

const WIRE_VERSION = 1 as const;
const MAX_WIRE_BYTES = 32 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_REQUEST_LIFETIME_MS = 600_000;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x53544144;
const SCHEMA_SQL = `
CREATE TABLE owner_authority_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_checksum TEXT NOT NULL
) STRICT;
CREATE TABLE owner_authority_decisions (
  request_digest TEXT PRIMARY KEY,
  facts_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  authority_id TEXT NOT NULL,
  denial_code TEXT,
  evidence_digest TEXT NOT NULL UNIQUE,
  evidence BLOB NOT NULL,
  decided_at_ms INTEGER NOT NULL CHECK (decided_at_ms > 0),
  CHECK ((decision = 'approved' AND denial_code IS NULL) OR
         (decision = 'denied' AND denial_code = 'user_denied'))
) STRICT;
`;
const SCHEMA_CHECKSUM = digestText(SCHEMA_SQL);

export type OwnerAuthorityFacts = TransferAuthorizationFacts | PolicyChangeFacts | VaultMigrationFacts;

export interface OwnerAuthorityDecision {
  readonly decision: "approved" | "denied";
  readonly authorityId: string;
  readonly denialCode?: "user_denied";
  readonly evidence: Uint8Array;
  readonly evidenceDigest: Sha256Digest;
  readonly factsDigest: Sha256Digest;
  readonly verificationProfile: typeof OWNER_AUTHORITY_EVIDENCE_PROFILE;
  readonly verifierId: string;
  readonly decidedAtMs: number;
}

interface OwnerAuthorityRequestMessage {
  readonly requestId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly facts: OwnerAuthorityFacts;
  readonly factsDigest: Sha256Digest;
}

interface OwnerAuthorityRequestEnvelope {
  readonly profile: typeof OWNER_AUTHORITY_REQUEST_PROFILE;
  readonly version: typeof WIRE_VERSION;
  readonly keyId: string;
  readonly message: OwnerAuthorityRequestMessage;
  readonly mac: string;
}

interface OwnerAuthorityResponseMessage {
  readonly responseId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly factsDigest: string;
  readonly decision: "approved" | "denied";
  readonly authorityId: string;
  readonly denialCode: "user_denied" | null;
  readonly evidenceDigest: string;
  readonly respondedAtMs: number;
  readonly expiresAtMs: number;
}

interface OwnerAuthorityResponseEnvelope {
  readonly profile: typeof OWNER_AUTHORITY_RESPONSE_PROFILE;
  readonly version: typeof WIRE_VERSION;
  readonly keyId: string;
  readonly message: OwnerAuthorityResponseMessage;
  readonly mac: string;
}

interface StoredDecision {
  readonly requestDigest: string;
  readonly factsDigest: string;
  readonly decision: "approved" | "denied";
  readonly authorityId: string;
  readonly denialCode?: "user_denied";
  readonly evidenceDigest: string;
  readonly evidence: Uint8Array;
  readonly decidedAtMs: number;
}

export class OwnerAuthorityClient implements TransferAuthorityModule, PolicyChangeAuthorityModule, VaultMigrationAuthorityModule {
  constructor(private readonly options: Readonly<{
    authenticationProvider: AuthorityAuthenticationProvider;
    transport: AuthorityDecisionTransport;
    trust: Ap2PublicKeyResolver;
    expectedAuthorityIssuer: string;
    now?: () => number;
  }>) {
    if (!options.authenticationProvider || !options.transport || !options.trust || !identity(options.expectedAuthorityIssuer)) {
      throw new Error("Owner Authority client configuration is invalid");
    }
  }

  async request(facts: OwnerAuthorityFacts): Promise<OwnerAuthorityDecision> {
    const canonicalFacts = validateFacts(facts);
    const factsDigest = digestJson(canonicalFacts);
    const issuedAtMs = Date.parse(canonicalFacts.issuedAt);
    const expiresAtMs = Date.parse(canonicalFacts.expiresAt);
    const now = timestamp(this.options.now ?? Date.now);
    if (
      issuedAtMs <= 0 ||
      expiresAtMs - issuedAtMs > MAX_REQUEST_LIFETIME_MS ||
      now < issuedAtMs - 30_000 ||
      now >= expiresAtMs
    ) {
      throw new Error("Owner Authority request is outside its freshness window");
    }
    return this.options.authenticationProvider.withAuthentication(async (authentication) => {
      const requestMessage: OwnerAuthorityRequestMessage = Object.freeze({
        requestId: `trq_${createHash("sha256").update(factsDigest).digest("base64url").slice(0, 22)}`,
        issuedAtMs,
        expiresAtMs,
        facts: canonicalFacts,
        factsDigest,
      });
      const requestWire = sealRequest(requestMessage, authentication);
      const requestDigest = digestText(requestWire);
      const transported = await this.options.transport.request(requestWire);
      if (!(transported.decisionEvidence instanceof Uint8Array) || transported.decisionEvidence.byteLength < 1 || transported.decisionEvidence.byteLength > MAX_EVIDENCE_BYTES) {
        throw new Error("Owner Authority evidence is invalid");
      }
      const response = parseResponse(transported.responseWire, authentication);
      if (
        response.message.requestId !== requestMessage.requestId ||
        response.message.requestDigest !== requestDigest ||
        response.message.factsDigest !== factsDigest ||
        response.message.evidenceDigest !== digestBytes(transported.decisionEvidence) ||
        response.message.expiresAtMs !== expiresAtMs ||
        response.message.respondedAtMs > expiresAtMs
      ) {
        throw new Error("Owner Authority response is not bound to the request");
      }
      await verifyDecisionEvidence(
        transported.decisionEvidence,
        response.message,
        canonicalFacts,
        this.options.trust,
        this.options.expectedAuthorityIssuer,
        now,
      );
      return Object.freeze({
        decision: response.message.decision,
        authorityId: response.message.authorityId,
        ...(response.message.denialCode ? { denialCode: response.message.denialCode } : {}),
        evidence: Uint8Array.from(transported.decisionEvidence),
        evidenceDigest: response.message.evidenceDigest as Sha256Digest,
        factsDigest,
        verificationProfile: OWNER_AUTHORITY_EVIDENCE_PROFILE,
        verifierId: this.options.expectedAuthorityIssuer,
        decidedAtMs: response.message.respondedAtMs,
      });
    });
  }
}

export class OwnerAuthorityService {
  private readonly active = new Map<string, Promise<StoredDecision>>();
  private readonly promptAdmission: AuthorityPromptAdmission;
  constructor(private readonly options: Readonly<{
    authenticationProvider: AuthorityAuthenticationProvider;
    signer: Ap2SigningIdentity;
    prompt: AuthorityApprovalPrompt;
    decisions: OwnerAuthorityDecisionStore;
    promptAdmission?: AuthorityPromptAdmission;
    now?: () => number;
  }>) {
    if (!options.authenticationProvider || !options.signer || !options.prompt || !options.decisions) {
      throw new Error("Owner Authority service configuration is invalid");
    }
    this.promptAdmission = options.promptAdmission ?? new AuthorityPromptAdmission(4);
  }

  async handleDecision(wire: string, signal?: AbortSignal): Promise<{ responseWire: string; decisionEvidence: Uint8Array }> {
    return this.options.authenticationProvider.withAuthentication(async (authentication) => {
      const request = parseRequest(wire, authentication);
      const requestDigest = digestText(wire);
      const now = timestamp(this.options.now ?? Date.now);
      if (
        request.message.expiresAtMs - request.message.issuedAtMs > MAX_REQUEST_LIFETIME_MS ||
        now < request.message.issuedAtMs - 30_000 ||
        now >= request.message.expiresAtMs
      ) {
        throw new Error("Owner Authority request is stale");
      }
      let decision = this.options.decisions.find(requestDigest);
      if (!decision) {
        const existing = this.active.get(requestDigest);
        const work = existing ?? this.decide(request.message, requestDigest, signal);
        if (!existing) this.active.set(requestDigest, work);
        try { decision = await work; }
        finally { if (this.active.get(requestDigest) === work) this.active.delete(requestDigest); }
      }
      if (decision.factsDigest !== request.message.factsDigest) {
        throw new Error("Owner Authority decision conflicts with the request");
      }
      const respondedAtMs = timestamp(this.options.now ?? Date.now);
      const responseMessage: OwnerAuthorityResponseMessage = Object.freeze({
        responseId: `trs_${createHash("sha256").update(requestDigest).update(decision.evidenceDigest).digest("base64url").slice(0, 22)}`,
        requestId: request.message.requestId,
        requestDigest,
        factsDigest: request.message.factsDigest,
        decision: decision.decision,
        authorityId: decision.authorityId,
        denialCode: decision.denialCode ?? null,
        evidenceDigest: decision.evidenceDigest,
        respondedAtMs,
        expiresAtMs: request.message.expiresAtMs,
      });
      return Object.freeze({
        responseWire: sealResponse(responseMessage, authentication),
        decisionEvidence: Uint8Array.from(decision.evidence),
      });
    });
  }

  private async decide(
    message: OwnerAuthorityRequestMessage,
    requestDigest: string,
    signal?: AbortSignal,
  ): Promise<StoredDecision> {
    let releasePrompt: (() => void) | undefined;
    try {
      releasePrompt = this.promptAdmission.acquire();
    } catch (error) {
      if (error instanceof AuthorityPromptAdmissionError) {
        throw new Error("Owner Authority prompt capacity is exhausted");
      }
      throw error;
    }
    const display = ownerAuthorityApprovalDisplay(message.facts, requestDigest);
    let approved: boolean;
    try {
      approved = await this.options.prompt.approve(display, signal);
    } finally {
      releasePrompt();
    }
    const decidedAtMs = timestamp(this.options.now ?? Date.now);
    if (decidedAtMs >= message.expiresAtMs) throw new Error("Owner Authority decision expired");
    const decision = approved ? "approved" as const : "denied" as const;
    const evidence = await issueDecisionEvidence(
      this.options.signer,
      message,
      requestDigest,
      decision,
      decidedAtMs,
    );
    return this.options.decisions.persist(Object.freeze({
      requestDigest,
      factsDigest: message.factsDigest,
      decision,
      authorityId: this.options.signer.issuer,
      ...(decision === "denied" ? { denialCode: "user_denied" as const } : {}),
      evidenceDigest: digestBytes(evidence),
      evidence,
      decidedAtMs,
    }));
  }
}


export class OwnerAuthorityDecisionStore {
  private readonly db: Database.Database;
  constructor(readonly filename: string) {
    prepareStore(filename);
    this.db = new Database(filename);
    try {
      if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
      this.db.pragma("trusted_schema = OFF");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("synchronous = FULL");
      if (filename !== ":memory:") this.db.pragma("journal_mode = WAL");
      this.initialize();
      this.verifyStartup();
    } catch (error) {
      if (this.db.open) this.db.close();
      throw new Error("Owner Authority decision store failed its startup checks", { cause: error });
    }
  }
  find(requestDigest: string): StoredDecision | undefined {
    requireDigest(requestDigest, "Owner Authority request digest");
    const row = this.db.prepare("SELECT * FROM owner_authority_decisions WHERE request_digest = ?").get(requestDigest) as DecisionRow | undefined;
    return row ? decisionFromRow(row) : undefined;
  }
  persist(decision: StoredDecision): StoredDecision {
    validateStoredDecision(decision);
    const save = this.db.transaction(() => {
      const prior = this.find(decision.requestDigest);
      if (prior) {
        if (!sameDecision(prior, decision)) throw new Error("Owner Authority decision conflicts with durable evidence");
        return prior;
      }
      this.db.prepare(
        `INSERT INTO owner_authority_decisions
           (request_digest, facts_digest, decision, authority_id, denial_code,
            evidence_digest, evidence, decided_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        decision.requestDigest, decision.factsDigest, decision.decision,
        decision.authorityId, decision.denialCode ?? null, decision.evidenceDigest,
        Buffer.from(decision.evidence), decision.decidedAtMs,
      );
      return this.find(decision.requestDigest)!;
    });
    return save.immediate();
  }
  close(): void {
    if (!this.db.open) return;
    if (this.filename !== ":memory:") this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
  integrityCheck(): true {
    const result = this.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (result.length !== 1 || result[0]?.integrity_check !== "ok") throw new Error("Owner Authority decision store integrity check failed");
    return true;
  }
  private initialize(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    const applicationId = this.db.pragma("application_id", { simple: true }) as number;
    if (version === SCHEMA_VERSION && applicationId === APPLICATION_ID) return;
    if (version !== 0 || applicationId !== 0) throw new Error("Owner Authority decision schema is unsupported");
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() as { count: number };
    if (count.count !== 0) throw new Error("refusing unversioned Owner Authority state");
    const initialize = this.db.transaction(() => {
      this.db.exec(SCHEMA_SQL);
      this.db.prepare("INSERT INTO owner_authority_meta (singleton, schema_checksum) VALUES (1, ?)").run(SCHEMA_CHECKSUM);
      this.db.pragma(`application_id = ${APPLICATION_ID}`);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    initialize.immediate();
  }
  private verifyStartup(): void {
    if ((this.db.pragma("user_version", { simple: true }) as number) !== SCHEMA_VERSION || (this.db.pragma("application_id", { simple: true }) as number) !== APPLICATION_ID) {
      throw new Error("Owner Authority decision schema identity is invalid");
    }
    const meta = this.db.prepare("SELECT schema_checksum FROM owner_authority_meta WHERE singleton = 1").get() as { schema_checksum: string } | undefined;
    if (meta?.schema_checksum !== SCHEMA_CHECKSUM || schemaFingerprint(this.db) !== expectedSchemaFingerprint()) {
      throw new Error("Owner Authority decision schema is invalid");
    }
    this.integrityCheck();
  }
}

export function isOwnerAuthorityRequestWire(wire: string): boolean {
  if (typeof wire !== "string" || Buffer.byteLength(wire, "utf8") > MAX_WIRE_BYTES) return false;
  try { return (JSON.parse(wire) as { profile?: unknown }).profile === OWNER_AUTHORITY_REQUEST_PROFILE; }
  catch { return false; }
}

function sealRequest(message: OwnerAuthorityRequestMessage, authentication: AuthorityAuthenticationInput): string {
  const unsigned = { profile: OWNER_AUTHORITY_REQUEST_PROFILE, version: WIRE_VERSION, keyId: authentication.keyId, message };
  return boundedJson({ ...unsigned, mac: mac(unsigned, authentication.keyBytes) });
}
function sealResponse(message: OwnerAuthorityResponseMessage, authentication: AuthorityAuthenticationInput): string {
  const unsigned = { profile: OWNER_AUTHORITY_RESPONSE_PROFILE, version: WIRE_VERSION, keyId: authentication.keyId, message };
  return boundedJson({ ...unsigned, mac: mac(unsigned, authentication.keyBytes) });
}
function parseRequest(wire: string, authentication: AuthorityAuthenticationInput): OwnerAuthorityRequestEnvelope {
  const value = parseEnvelope(wire) as unknown as OwnerAuthorityRequestEnvelope;
  if (value.profile !== OWNER_AUTHORITY_REQUEST_PROFILE || value.version !== WIRE_VERSION || value.keyId !== authentication.keyId) throw new Error("Owner Authority request profile is invalid");
  const message = validateRequestMessage(value.message);
  verifyMac({ profile: value.profile, version: value.version, keyId: value.keyId, message }, value.mac, authentication.keyBytes);
  if (boundedJson(value) !== wire) throw new Error("Owner Authority request is not canonical");
  return Object.freeze({ ...value, message });
}
function parseResponse(wire: string, authentication: AuthorityAuthenticationInput): OwnerAuthorityResponseEnvelope {
  const value = parseEnvelope(wire) as unknown as OwnerAuthorityResponseEnvelope;
  if (value.profile !== OWNER_AUTHORITY_RESPONSE_PROFILE || value.version !== WIRE_VERSION || value.keyId !== authentication.keyId) throw new Error("Owner Authority response profile is invalid");
  const message = validateResponseMessage(value.message);
  verifyMac({ profile: value.profile, version: value.version, keyId: value.keyId, message }, value.mac, authentication.keyBytes);
  if (boundedJson(value) !== wire) throw new Error("Owner Authority response is not canonical");
  return Object.freeze({ ...value, message });
}

function validateRequestMessage(value: OwnerAuthorityRequestMessage): OwnerAuthorityRequestMessage {
  if (!value || !/^trq_[A-Za-z0-9_-]{22}$/.test(value.requestId) || !Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= value.issuedAtMs) throw new Error("Owner Authority request message is invalid");
  const facts = validateFacts(value.facts);
  if (value.factsDigest !== digestJson(facts)) throw new Error("Owner Authority facts digest is invalid");
  return Object.freeze({ ...value, facts });
}
function validateResponseMessage(value: OwnerAuthorityResponseMessage): OwnerAuthorityResponseMessage {
  if (!value || !/^trs_[A-Za-z0-9_-]{22}$/.test(value.responseId) || !/^trq_[A-Za-z0-9_-]{22}$/.test(value.requestId) || !requireDigest(value.requestDigest, "request") || !requireDigest(value.factsDigest, "facts") || !requireDigest(value.evidenceDigest, "evidence") || !identity(value.authorityId) || !Number.isSafeInteger(value.respondedAtMs) || !Number.isSafeInteger(value.expiresAtMs)) throw new Error("Owner Authority response message is invalid");
  if ((value.decision === "approved" && value.denialCode !== null) || (value.decision === "denied" && value.denialCode !== "user_denied")) throw new Error("Owner Authority response decision is invalid");
  return Object.freeze({ ...value });
}

function validateFacts(facts: OwnerAuthorityFacts): OwnerAuthorityFacts {
  if (facts?.profile === "sompi.transfer.1") return validateTransferFacts(facts);
  if (facts?.profile === "sompi.policy-change.1") return validatePolicyChangeFacts(facts);
  if (facts?.profile === "sompi.vault-migration.1") return validateVaultMigrationFacts(facts);
  throw new Error("Owner Authority facts profile is unsupported");
}

function validateTransferFacts(facts: TransferAuthorizationFacts): TransferAuthorizationFacts {
  if (!facts || facts.profile !== "sompi.transfer.1" || !/^trf_[A-Za-z0-9_-]{22}$/.test(facts.transferId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(facts.requestKey) || !/^kaspatest:[a-z0-9]+$/.test(facts.sourceVaultAddress) || !/^kaspatest:[a-z0-9]+$/.test(facts.destination) || facts.asset !== "KAS" || facts.network !== "kaspa:testnet-10" || !atomic(facts.amountAtomic, false) || !atomic(facts.feeCeilingAtomic, true) || !atomic(facts.maximumTotalAtomic, false) || BigInt(facts.amountAtomic) + BigInt(facts.feeCeilingAtomic) !== BigInt(facts.maximumTotalAtomic) || !validLifetime(facts.issuedAt, facts.expiresAt) || !requireDigest(facts.sourceVaultDigest, "vault") || !requireDigest(facts.policyDigest, "policy") || !Number.isSafeInteger(facts.operatorManifestRevision) || facts.operatorManifestRevision < 1 || !requireDigest(facts.operatorManifestDigest, "manifest") || (facts.finalityFloor !== "accepted" && facts.finalityFloor !== "depth-confirmed")) throw new Error("Owner Authority facts are invalid");
  return Object.freeze({
    profile: facts.profile, transferId: facts.transferId, requestKey: facts.requestKey,
    sourceVaultAddress: facts.sourceVaultAddress, sourceVaultDigest: facts.sourceVaultDigest,
    destination: facts.destination, amountAtomic: facts.amountAtomic, asset: facts.asset,
    network: facts.network, feeCeilingAtomic: facts.feeCeilingAtomic,
    maximumTotalAtomic: facts.maximumTotalAtomic, issuedAt: facts.issuedAt, expiresAt: facts.expiresAt,
    policyDigest: facts.policyDigest, operatorManifestRevision: facts.operatorManifestRevision,
    operatorManifestDigest: facts.operatorManifestDigest, finalityFloor: facts.finalityFloor,
  });
}

function validatePolicyChangeFacts(facts: PolicyChangeFacts): PolicyChangeFacts {
  if (
    !facts ||
    facts.profile !== "sompi.policy-change.1" ||
    !/^pcg_[A-Za-z0-9_-]{22}$/.test(facts.policyChangeId) ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(facts.requestKey) ||
    !requireDigest(facts.expectedPolicyDigest, "policy") ||
    !Number.isSafeInteger(facts.expectedPolicyVersion) ||
    facts.expectedPolicyVersion < 1 ||
    !Number.isSafeInteger(facts.expectedPolicyGeneration) ||
    facts.expectedPolicyGeneration < 1 ||
    !requireDigest(facts.expectedVaultDigest, "vault") ||
    !atomic(facts.previousMaximumPerPaymentAtomic, false) ||
    !atomic(facts.previousMaximumPerHourAtomic, false) ||
    !atomic(facts.proposedMaximumPerPaymentAtomic, false) ||
    !atomic(facts.proposedMaximumPerHourAtomic, false) ||
    !atomic(facts.vaultMaximumOutflowAtomic, false) ||
    BigInt(facts.previousMaximumPerPaymentAtomic) > BigInt(facts.previousMaximumPerHourAtomic) ||
    BigInt(facts.proposedMaximumPerPaymentAtomic) > BigInt(facts.proposedMaximumPerHourAtomic) ||
    BigInt(facts.proposedMaximumPerPaymentAtomic) > BigInt(facts.vaultMaximumOutflowAtomic) ||
    BigInt(facts.proposedMaximumPerHourAtomic) > BigInt(facts.vaultMaximumOutflowAtomic) ||
    facts.everyPaymentRequiresApproval !== true ||
    !Number.isSafeInteger(facts.operatorManifestRevision) ||
    facts.operatorManifestRevision < 1 ||
    !requireDigest(facts.operatorManifestDigest, "manifest") ||
    !validLifetime(facts.issuedAt, facts.expiresAt)
  ) {
    throw new Error("Owner Authority Policy Change facts are invalid");
  }
  return Object.freeze({ ...facts });
}

function validateVaultMigrationFacts(facts: VaultMigrationFacts): VaultMigrationFacts {
  if (
    !facts || facts.profile !== "sompi.vault-migration.1" ||
    !/^vmg_[A-Za-z0-9_-]{22}$/.test(facts.vaultMigrationId) ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(facts.requestKey) ||
    !requireDigest(facts.oldVaultDigest, "vault") ||
    !requireDigest(facts.expectedPolicyDigest, "policy") ||
    !Number.isSafeInteger(facts.expectedPolicyGeneration) || facts.expectedPolicyGeneration < 1 ||
    !atomic(facts.oldMaximumOutflowAtomic, false) ||
    !atomic(facts.newMaximumOutflowAtomic, false) ||
    !atomic(facts.windowSizeDaa, false) ||
    !atomic(facts.windowStartDaa, true) ||
    !atomic(facts.spentInWindowAtomic, true) ||
    !/^kaspatest:[a-z0-9]+$/.test(facts.stableReceiveAddress) ||
    facts.stableReceiveAddressWillNotChange !== true || facts.requiresOfflineOwnerKey !== true ||
    !Number.isSafeInteger(facts.operatorManifestRevision) || facts.operatorManifestRevision < 1 ||
    !requireDigest(facts.operatorManifestDigest, "manifest") || !validLifetime(facts.issuedAt, facts.expiresAt)
  ) throw new Error("Owner Authority Vault Migration facts are invalid");
  return Object.freeze({ ...facts });
}

async function issueDecisionEvidence(signer: Ap2SigningIdentity, message: OwnerAuthorityRequestMessage, requestDigest: string, decision: "approved" | "denied", decidedAtMs: number): Promise<Uint8Array> {
  const key = await importSigningKey(signer);
  const payload = {
    profile: OWNER_AUTHORITY_EVIDENCE_PROFILE,
    authority_id: signer.issuer,
    request_digest: requestDigest,
    facts_digest: message.factsDigest,
    decision,
    ...(decision === "denied" ? { denial_code: "user_denied" } : {}),
    facts: message.facts,
  };
  const artifact = await new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: signer.kid, typ: "JWT" })
    .setIssuer(signer.issuer)
    .setAudience(OWNER_AUTHORITY_AUDIENCE)
    .setIssuedAt(Math.floor(decidedAtMs / 1000))
    .setExpirationTime(Math.floor(message.expiresAtMs / 1000))
    .sign(key);
  return Uint8Array.from(Buffer.from(artifact, "ascii"));
}

async function verifyDecisionEvidence(bytes: Uint8Array, response: OwnerAuthorityResponseMessage, facts: OwnerAuthorityFacts, trust: Ap2PublicKeyResolver, expectedIssuer: string, nowMs: number): Promise<void> {
  const artifact = Buffer.from(bytes).toString("ascii");
  const header = decodeProtectedHeader(artifact);
  if (header.alg !== "ES256" || header.typ !== "JWT" || typeof header.kid !== "string") throw new Error("Owner Authority evidence header is invalid");
  const { key } = await resolveTrustedPublicKey({
    resolver: trust,
    role: "authority",
    issuer: expectedIssuer,
    kid: header.kid,
  });
  const verified = await jwtVerify(artifact, key, { issuer: expectedIssuer, audience: OWNER_AUTHORITY_AUDIENCE, algorithms: ["ES256"], currentDate: new Date(nowMs), clockTolerance: 30 });
  const payload = verified.payload as JWTPayload & Record<string, unknown>;
  if (payload.profile !== OWNER_AUTHORITY_EVIDENCE_PROFILE || payload.authority_id !== response.authorityId || payload.request_digest !== response.requestDigest || payload.facts_digest !== response.factsDigest || payload.decision !== response.decision || JSON.stringify(payload.facts) !== JSON.stringify(facts) || (response.decision === "denied" ? payload.denial_code !== "user_denied" : payload.denial_code !== undefined)) throw new Error("Owner Authority evidence facts are invalid");
}

interface DecisionRow { request_digest: string; facts_digest: string; decision: "approved" | "denied"; authority_id: string; denial_code: "user_denied" | null; evidence_digest: string; evidence: Buffer; decided_at_ms: number; }
function decisionFromRow(row: DecisionRow): StoredDecision {
  const decision = Object.freeze({ requestDigest: row.request_digest, factsDigest: row.facts_digest, decision: row.decision, authorityId: row.authority_id, ...(row.denial_code ? { denialCode: row.denial_code } : {}), evidenceDigest: row.evidence_digest, evidence: Uint8Array.from(row.evidence), decidedAtMs: row.decided_at_ms });
  validateStoredDecision(decision);
  return decision;
}
function validateStoredDecision(value: StoredDecision): void {
  if (!requireDigest(value.requestDigest, "request") || !requireDigest(value.factsDigest, "facts") || !identity(value.authorityId) || !requireDigest(value.evidenceDigest, "evidence") || !(value.evidence instanceof Uint8Array) || value.evidence.byteLength < 1 || value.evidence.byteLength > MAX_EVIDENCE_BYTES || digestBytes(value.evidence) !== value.evidenceDigest || !Number.isSafeInteger(value.decidedAtMs) || value.decidedAtMs <= 0 || (value.decision === "approved" ? value.denialCode !== undefined : value.denialCode !== "user_denied")) throw new Error("Owner Authority stored decision is invalid");
}
function sameDecision(a: StoredDecision, b: StoredDecision): boolean { return a.requestDigest === b.requestDigest && a.factsDigest === b.factsDigest && a.decision === b.decision && a.authorityId === b.authorityId && a.denialCode === b.denialCode && a.evidenceDigest === b.evidenceDigest && a.decidedAtMs === b.decidedAtMs && Buffer.from(a.evidence).equals(Buffer.from(b.evidence)); }
function parseEnvelope(wire: string): Record<string, unknown> { if (typeof wire !== "string" || wire.length < 1 || Buffer.byteLength(wire, "utf8") > MAX_WIRE_BYTES) throw new Error("Owner Authority wire is invalid"); let value: unknown; try { value = JSON.parse(wire); } catch { throw new Error("Owner Authority wire is invalid"); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Owner Authority wire is invalid"); return value as Record<string, unknown>; }
function boundedJson(value: unknown): string { const text = JSON.stringify(value); if (Buffer.byteLength(text, "utf8") > MAX_WIRE_BYTES) throw new Error("Owner Authority wire exceeds its bound"); return text; }
function mac(value: unknown, key: Uint8Array): string { return createHmac("sha256", key).update(JSON.stringify(value), "utf8").digest("base64url"); }
function verifyMac(value: unknown, candidate: string, key: Uint8Array): void { if (typeof candidate !== "string" || !BASE64URL.test(candidate)) throw new Error("Owner Authority MAC is invalid"); const actual = Buffer.from(mac(value, key)); const supplied = Buffer.from(candidate); if (actual.byteLength !== supplied.byteLength || !timingSafeEqual(actual, supplied)) throw new Error("Owner Authority MAC is invalid"); }
function digestJson(value: unknown): Sha256Digest { return digestText(JSON.stringify(value)); }
function digestText(value: string): Sha256Digest { return digestBytes(Buffer.from(value, "utf8")); }
function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}` as Sha256Digest;
}
function requireDigest(value: string, _label: string): boolean { if (!DIGEST.test(value)) throw new Error("Owner Authority digest is invalid"); return true; }
function atomic(value: string, zero: boolean): boolean { return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= (1n << 64n) - 1n && (zero || value !== "0"); }
function validLifetime(issuedAt: string, expiresAt: string): boolean {
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isSafeInteger(issuedAtMs) &&
    Number.isSafeInteger(expiresAtMs) &&
    issuedAtMs > 0 &&
    expiresAtMs > issuedAtMs &&
    expiresAtMs - issuedAtMs <= MAX_REQUEST_LIFETIME_MS;
}
function identity(value: string): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value); }
function timestamp(now: () => number): number { const value = now(); if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Owner Authority clock is invalid"); return value; }
function schemaFingerprint(db: Database.Database): string {
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  return digestText(JSON.stringify(rows));
}
function expectedSchemaFingerprint(): string {
  const expected = new Database(":memory:");
  try { expected.exec(SCHEMA_SQL); return schemaFingerprint(expected); }
  finally { expected.close(); }
}
function prepareStore(filename: string): void {
  if (filename === ":memory:") return;
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) throw new Error("Owner Authority store path is invalid");
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(path.dirname(filename));
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error("Owner Authority store directory is unsafe");
  if (fs.existsSync(filename)) {
    const file = fs.lstatSync(filename);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== uid || (file.mode & 0o077) !== 0) throw new Error("Owner Authority store file is unsafe");
  }
}
