import {
  AUTHORITY_MAX_DECISION_EVIDENCE_BYTES,
  AUTHORITY_MAX_WIRE_BYTES,
} from "./protocol.js";
import type { AuthorityService } from "./service.js";
import {
  AUTHORITY_MAX_RESPONSE_FRAME_BYTES,
  AuthorityUnixClient,
  AuthorityUnixServer,
  type AuthorityUnixClientOptions,
  type AuthorityUnixServerOptions,
} from "./transport.js";

export const AUTHORITY_DECISION_ENDPOINT_PROFILE =
  "sompi.authority.decision-response" as const;
export const AUTHORITY_DECISION_ENDPOINT_VERSION = 1 as const;

export interface AuthorityDecisionEndpointResult {
  readonly responseWire: string;
  readonly decisionEvidence: Uint8Array;
}

/** Authority-side application endpoint over the already bounded IPC frame. */
export class AuthorityDecisionEndpoint {
  constructor(private readonly service: Pick<AuthorityService, "handleDecision">) {
    if (!service || typeof service.handleDecision !== "function") {
      throw new Error("authority decision endpoint configuration is invalid");
    }
  }

  async handle(authenticatedRequestWire: string): Promise<string> {
    const result = await this.service.handleDecision(authenticatedRequestWire);
    return encodeAuthorityDecisionEndpointResult(result);
  }
}

export interface AuthorityUnixDecisionServerOptions
extends Omit<AuthorityUnixServerOptions, "handle"> {
  readonly endpoint: AuthorityDecisionEndpoint;
}

export class AuthorityUnixDecisionServer {
  private readonly server: AuthorityUnixServer;

  constructor(options: AuthorityUnixDecisionServerOptions) {
    if (!options.endpoint) throw new Error("authority Unix endpoint is required");
    this.server = new AuthorityUnixServer({
      socketPath: options.socketPath,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.socketGroupId === undefined
        ? {}
        : { socketGroupId: options.socketGroupId }),
      handle: (wire) => options.endpoint.handle(wire),
    });
  }

  start(): Promise<void> {
    return this.server.start();
  }

  close(): Promise<void> {
    return this.server.close();
  }
}

/** MCP-side endpoint client; structurally satisfies AuthorityDecisionTransport. */
export class AuthorityUnixDecisionClient {
  private readonly client: AuthorityUnixClient;

  constructor(options: AuthorityUnixClientOptions) {
    this.client = new AuthorityUnixClient(options);
  }

  async request(authenticatedRequestWire: string): Promise<AuthorityDecisionEndpointResult> {
    return decodeAuthorityDecisionEndpointResult(
      await this.client.request(authenticatedRequestWire),
    );
  }
}

export function encodeAuthorityDecisionEndpointResult(
  input: AuthorityDecisionEndpointResult,
): string {
  validateResult(input);
  const wire = JSON.stringify({
    profile: AUTHORITY_DECISION_ENDPOINT_PROFILE,
    version: AUTHORITY_DECISION_ENDPOINT_VERSION,
    responseWire: input.responseWire,
    decisionEvidence: Buffer.from(input.decisionEvidence).toString("base64url"),
  });
  if (Buffer.byteLength(wire, "utf8") > AUTHORITY_MAX_RESPONSE_FRAME_BYTES) {
    throw new Error("authority decision endpoint response exceeds its bound");
  }
  return wire;
}

export function decodeAuthorityDecisionEndpointResult(
  wire: string,
): AuthorityDecisionEndpointResult {
  if (
    typeof wire !== "string" ||
    wire.length === 0 ||
    Buffer.byteLength(wire, "utf8") > AUTHORITY_MAX_RESPONSE_FRAME_BYTES
  ) {
    throw new Error("authority decision endpoint response is malformed");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(wire);
  } catch {
    throw new Error("authority decision endpoint response is malformed");
  }
  if (!isRecord(candidate)) throw new Error("authority decision endpoint response is malformed");
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "decisionEvidence" ||
    keys[1] !== "profile" ||
    keys[2] !== "responseWire" ||
    keys[3] !== "version" ||
    candidate.profile !== AUTHORITY_DECISION_ENDPOINT_PROFILE ||
    candidate.version !== AUTHORITY_DECISION_ENDPOINT_VERSION ||
    typeof candidate.responseWire !== "string" ||
    typeof candidate.decisionEvidence !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(candidate.decisionEvidence)
  ) {
    throw new Error("authority decision endpoint response is malformed");
  }
  const evidence = Buffer.from(candidate.decisionEvidence, "base64url");
  if (evidence.toString("base64url") !== candidate.decisionEvidence) {
    evidence.fill(0);
    throw new Error("authority decision endpoint response is malformed");
  }
  const result = Object.freeze({
    responseWire: candidate.responseWire,
    decisionEvidence: Uint8Array.from(evidence),
  });
  evidence.fill(0);
  validateResult(result);
  if (encodeAuthorityDecisionEndpointResult(result) !== wire) {
    throw new Error("authority decision endpoint response is not canonical");
  }
  return result;
}

function validateResult(input: AuthorityDecisionEndpointResult): void {
  if (
    !input ||
    typeof input.responseWire !== "string" ||
    input.responseWire.length === 0 ||
    Buffer.byteLength(input.responseWire, "utf8") > AUTHORITY_MAX_WIRE_BYTES ||
    !(input.decisionEvidence instanceof Uint8Array) ||
    input.decisionEvidence.byteLength === 0 ||
    input.decisionEvidence.byteLength > AUTHORITY_MAX_DECISION_EVIDENCE_BYTES
  ) {
    throw new Error("authority decision endpoint response is malformed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
