import { isIP } from "node:net";
import { canonicalMediaType, canonicalRequestUrl, requestFingerprint } from "./identity.js";
import type { PurchaseResource, Sha256Digest } from "./types.js";

const DEFAULT_LIMITS: EgressLimits = Object.freeze({
  maxRedirects: 3,
  maxResolvedAddresses: 16,
  maxResponseHeaderBytes: 32 * 1024,
  maxResponseBodyBytes: 1024 * 1024,
  requestTimeoutMs: 15_000,
});

const HTTP_METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type EgressProtocol = "https:" | "http:";

export interface EgressAllowRule {
  /** Exact hostname or IP literal. Wildcards and suffix matching are not supported. */
  hostname: string;
  /** Explicit effective ports, including 443/80 when default ports are intended. */
  ports: readonly number[];
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type EgressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface EgressLimits {
  maxRedirects: number;
  maxResolvedAddresses: number;
  maxResponseHeaderBytes: number;
  maxResponseBodyBytes: number;
  requestTimeoutMs: number;
}

export interface EgressPolicyOptions {
  allowRules: readonly EgressAllowRule[];
  resolver: EgressResolver;
  limits?: Partial<EgressLimits>;
  now?: () => number;
}

export interface EgressRequestInput {
  url: string;
  method: string;
  body?: Uint8Array;
  mediaType?: string;
}

export interface RedirectRequestOverride {
  method?: string;
  /** Supply this explicitly when changing method, even when the new body is empty. */
  body?: Uint8Array;
  mediaType?: string;
}

export interface PinnedTransportConnection {
  /** Connect only to one of these addresses. The transport must not resolve again. */
  addresses: readonly ResolvedAddress[];
  port: number;
  /** Original HTTP authority for Host/:authority. */
  authority: string;
  /** Original DNS hostname for TLS SNI/certificate verification. Omitted for IP literals. */
  serverName?: string;
}

export interface SafeTransportHop {
  url: string;
  protocol: EgressProtocol;
  hostname: string;
  port: number;
  method: string;
  body?: Uint8Array;
  requestFingerprintInput: Readonly<PurchaseResource>;
  requestFingerprint: Sha256Digest;
  redirectCount: number;
  startedAtMs: number;
  deadlineAtMs: number;
  limits: Readonly<EgressLimits>;
  connection: Readonly<PinnedTransportConnection>;
}

export type EgressErrorCode =
  | "invalid_configuration"
  | "invalid_url"
  | "protocol_denied"
  | "credentials_denied"
  | "host_denied"
  | "port_denied"
  | "resolution_failed"
  | "unsafe_address"
  | "redirect_limit"
  | "redirect_request_invalid"
  | "deadline_exceeded"
  | "invalid_response_headers"
  | "response_headers_too_large"
  | "response_body_too_large";

export class EgressPolicyError extends Error {
  constructor(
    readonly code: EgressErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "EgressPolicyError";
  }
}

interface NormalizedAllowRule {
  hostname: string;
  ports: ReadonlySet<number>;
}

/**
 * Validates and resolves outbound Purchase requests without performing I/O other
 * than the injected resolver. The returned connection contract is address-pinned:
 * an HTTP transport must connect to one of those exact addresses while retaining
 * the original authority and TLS server name.
 */
export class EgressPolicy {
  private readonly rules: readonly NormalizedAllowRule[];
  private readonly resolver: EgressResolver;
  private readonly protocols: ReadonlySet<EgressProtocol>;
  private readonly limits: Readonly<EgressLimits>;
  private readonly now: () => number;

  constructor(options: EgressPolicyOptions) {
    if (!options || typeof options.resolver !== "function") {
      throw configurationError("an injected resolver is required");
    }
    if (!Array.isArray(options.allowRules) || options.allowRules.length === 0) {
      throw configurationError("at least one exact hostname/port allow rule is required");
    }
    this.rules = Object.freeze(options.allowRules.map(normalizeRule));
    this.resolver = options.resolver;
    this.protocols = new Set(["https:"]);
    this.limits = normalizeLimits(options.limits);
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async validateRequest(input: EgressRequestInput): Promise<SafeTransportHop> {
    const startedAtMs = readClock(this.now);
    const deadlineAtMs = safeAdd(startedAtMs, this.limits.requestTimeoutMs, "request deadline");
    return this.validateHop(input, 0, startedAtMs, deadlineAtMs);
  }

  async validateRedirect(
    previous: SafeTransportHop,
    location: string,
    override: RedirectRequestOverride = {}
  ): Promise<SafeTransportHop> {
    this.assertDeadline(previous.deadlineAtMs);
    if (previous.redirectCount >= this.limits.maxRedirects) {
      throw new EgressPolicyError("redirect_limit", `redirect limit ${this.limits.maxRedirects} exceeded`);
    }
    let target: string;
    try {
      target = new URL(location, previous.url).href;
    } catch (error) {
      throw new EgressPolicyError("invalid_url", "redirect location is not a valid URL", { cause: error });
    }
    const method = override.method ?? previous.method;
    const methodChanged = canonicalMethod(method) !== previous.method;
    if (methodChanged && !Object.prototype.hasOwnProperty.call(override, "body")) {
      throw new EgressPolicyError(
        "redirect_request_invalid",
        "a redirect method change requires an explicit body decision"
      );
    }
    const body = Object.prototype.hasOwnProperty.call(override, "body")
      ? override.body
      : previous.body;
    const mediaType = Object.prototype.hasOwnProperty.call(override, "mediaType")
      ? override.mediaType
      : previous.requestFingerprintInput.mediaType;
    return this.validateHop(
      { url: target, method, body, mediaType },
      previous.redirectCount + 1,
      previous.startedAtMs,
      previous.deadlineAtMs
    );
  }

  createResponseGuard(hop: SafeTransportHop, abort: (reason: EgressPolicyError) => void): EgressResponseGuard {
    return new EgressResponseGuard(hop.limits, hop.deadlineAtMs, this.now, abort);
  }

  private async validateHop(
    input: EgressRequestInput,
    redirectCount: number,
    startedAtMs: number,
    deadlineAtMs: number
  ): Promise<SafeTransportHop> {
    this.assertDeadline(deadlineAtMs);
    const url = canonicalUrl(input.url);
    const protocol = url.protocol as EgressProtocol;
    if (!this.protocols.has(protocol)) {
      throw new EgressPolicyError("protocol_denied", `outbound protocol ${protocol} is not allowed`);
    }
    if (url.username || url.password) {
      throw new EgressPolicyError("credentials_denied", "outbound URLs must not contain credentials");
    }

    const hostname = canonicalHostname(url);
    if (hostname !== stripIpv6Brackets(url.hostname)) {
      url.hostname = hostname;
    }
    url.hash = "";
    const canonical = canonicalRequestUrl(url.href);
    const port = effectivePort(url);
    this.assertAllowed(hostname, port);

    const addresses = await this.resolveAndValidate(hostname);
    const method = canonicalMethod(input.method);
    const body = input.body === undefined ? undefined : Uint8Array.from(input.body);
    const mediaType = canonicalMediaType(input.mediaType);
    const fingerprintInput: PurchaseResource = {
      url: canonical,
      method,
      body,
      mediaType,
    };
    const fingerprint = requestFingerprint(fingerprintInput);
    const connection: PinnedTransportConnection = Object.freeze({
      addresses,
      port,
      authority: url.host,
      serverName: isIP(hostname) === 0 ? hostname : undefined,
    });

    return Object.freeze({
      url: canonical,
      protocol,
      hostname,
      port,
      method,
      get body() {
        return body === undefined ? undefined : Uint8Array.from(body);
      },
      get requestFingerprintInput() {
        return Object.freeze({
          url: canonical,
          method,
          body: body === undefined ? undefined : Uint8Array.from(body),
          mediaType,
        });
      },
      requestFingerprint: fingerprint,
      redirectCount,
      startedAtMs,
      deadlineAtMs,
      limits: this.limits,
      connection,
    });
  }

  private assertAllowed(hostname: string, port: number): void {
    const hostRules = this.rules.filter((rule) => rule.hostname === hostname);
    if (hostRules.length === 0) {
      throw new EgressPolicyError("host_denied", `outbound hostname ${hostname} is not explicitly allowed`);
    }
    if (!hostRules.some((rule) => rule.ports.has(port))) {
      throw new EgressPolicyError("port_denied", `outbound port ${port} is not allowed for ${hostname}`);
    }
  }

  private async resolveAndValidate(hostname: string): Promise<readonly ResolvedAddress[]> {
    let resolved: readonly ResolvedAddress[];
    try {
      resolved = await this.resolver(hostname);
    } catch (error) {
      throw new EgressPolicyError("resolution_failed", `resolution failed for ${hostname}`, { cause: error });
    }
    if (!Array.isArray(resolved) || resolved.length === 0) {
      throw new EgressPolicyError("resolution_failed", `resolution returned no addresses for ${hostname}`);
    }
    if (resolved.length > this.limits.maxResolvedAddresses) {
      throw new EgressPolicyError(
        "resolution_failed",
        `resolution returned more than ${this.limits.maxResolvedAddresses} addresses for ${hostname}`
      );
    }

    const literalFamily = isIP(hostname);
    const literalValue = literalFamily === 4
      ? BigInt(ipv4ToNumber(hostname))
      : literalFamily === 6
        ? ipv6ToBigInt(hostname)
        : undefined;
    const unique = new Map<string, ResolvedAddress>();
    for (const result of resolved) {
      if (!result || typeof result.address !== "string") {
        throw new EgressPolicyError("resolution_failed", "resolver returned an invalid address record");
      }
      const address = result.address.toLowerCase();
      const family = isIP(address);
      if (family !== result.family || (family !== 4 && family !== 6)) {
        throw new EgressPolicyError("resolution_failed", `resolver returned an invalid address for ${hostname}`);
      }
      assertPublicAddress(address);
      if (literalValue !== undefined) {
        const value = family === 4 ? BigInt(ipv4ToNumber(address)) : ipv6ToBigInt(address);
        if (family !== literalFamily || value !== literalValue) {
          throw new EgressPolicyError("resolution_failed", "an IP-literal host resolved to a different address");
        }
      }
      unique.set(`${family}:${address}`, Object.freeze({ address, family }));
    }
    return Object.freeze([...unique.values()]);
  }

  private assertDeadline(deadlineAtMs: number): void {
    if (readClock(this.now) >= deadlineAtMs) {
      throw new EgressPolicyError("deadline_exceeded", "outbound request deadline has expired");
    }
  }
}

/** A deterministic streaming guard for a transport implementing SafeTransportHop. */
export class EgressResponseGuard {
  private headerBytes: number | undefined;
  private bodyBytes = 0;

  constructor(
    private readonly limits: Readonly<EgressLimits>,
    private readonly deadlineAtMs: number,
    private readonly now: () => number,
    private readonly abort: (reason: EgressPolicyError) => void
  ) {}

  acceptHeaders(headers: Iterable<readonly [string, string]>): number {
    this.checkTime();
    if (this.headerBytes !== undefined) {
      return this.fail("invalid_response_headers", "response headers were supplied more than once");
    }
    let total = 2; // terminating CRLF
    for (const [name, value] of headers) {
      if (!HEADER_NAME_PATTERN.test(name) || /[\r\n\u0000]/.test(value)) {
        return this.fail("invalid_response_headers", "response headers contain invalid characters");
      }
      total = safeAdd(total, Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4, "header size");
      if (total > this.limits.maxResponseHeaderBytes) {
        return this.fail(
          "response_headers_too_large",
          `response headers exceed ${this.limits.maxResponseHeaderBytes} bytes`
        );
      }
    }
    this.headerBytes = total;
    return total;
  }

  acceptBodyChunk(chunk: Uint8Array): number {
    this.checkTime();
    this.bodyBytes = safeAdd(this.bodyBytes, chunk.byteLength, "response body size");
    if (this.bodyBytes > this.limits.maxResponseBodyBytes) {
      return this.fail(
        "response_body_too_large",
        `response body exceeds ${this.limits.maxResponseBodyBytes} bytes`
      );
    }
    return this.bodyBytes;
  }

  checkTime(): void {
    if (readClock(this.now) >= this.deadlineAtMs) {
      this.fail("deadline_exceeded", "outbound request deadline has expired");
    }
  }

  private fail(code: EgressErrorCode, message: string): never {
    const error = new EgressPolicyError(code, message);
    try {
      this.abort(error);
    } catch {
      // The policy error remains authoritative even if transport abort cleanup fails.
    }
    throw error;
  }
}

export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToNumber(address);
    for (const range of IPV4_DENY_RANGES) {
      if (ipv4InPrefix(value, range.base, range.prefix)) {
        throw new EgressPolicyError("unsafe_address", `resolved IPv4 address is ${range.reason}`);
      }
    }
    return;
  }
  if (family === 6) {
    if (address.includes("%")) {
      throw new EgressPolicyError("unsafe_address", "scoped IPv6 addresses are not allowed");
    }
    const value = ipv6ToBigInt(address);
    for (const range of IPV6_DENY_RANGES) {
      if (bigIntInPrefix(value, range.base, range.prefix, 128)) {
        throw new EgressPolicyError("unsafe_address", `resolved IPv6 address is ${range.reason}`);
      }
    }
    if (!bigIntInPrefix(value, ipv6ToBigInt("2000::"), 3, 128)) {
      throw new EgressPolicyError("unsafe_address", "resolved IPv6 address is outside global unicast space");
    }
    return;
  }
  throw new EgressPolicyError("resolution_failed", "resolver returned a non-IP address");
}

const IPV4_DENY_RANGES = [
  v4Range("0.0.0.0", 8, "unspecified or reserved"),
  v4Range("10.0.0.0", 8, "private"),
  v4Range("100.64.0.0", 10, "carrier-grade NAT"),
  v4Range("127.0.0.0", 8, "loopback"),
  v4Range("169.254.0.0", 16, "link-local"),
  v4Range("172.16.0.0", 12, "private"),
  v4Range("192.0.0.0", 24, "reserved"),
  v4Range("192.0.2.0", 24, "documentation"),
  v4Range("192.88.99.0", 24, "reserved"),
  v4Range("192.168.0.0", 16, "private"),
  v4Range("198.18.0.0", 15, "benchmark"),
  v4Range("198.51.100.0", 24, "documentation"),
  v4Range("203.0.113.0", 24, "documentation"),
  v4Range("224.0.0.0", 4, "multicast"),
  v4Range("240.0.0.0", 4, "reserved"),
] as const;

const IPV6_DENY_RANGES = [
  v6Range("::", 128, "unspecified"),
  v6Range("::1", 128, "loopback"),
  v6Range("::", 96, "IPv4-compatible or reserved"),
  v6Range("::ffff:0:0", 96, "IPv4-mapped"),
  v6Range("64:ff9b::", 96, "IPv4 translation"),
  v6Range("64:ff9b:1::", 48, "local IPv4 translation"),
  v6Range("100::", 64, "discard-only"),
  v6Range("2001::", 23, "IETF protocol assignment"),
  v6Range("2001:db8::", 32, "documentation"),
  v6Range("2002::", 16, "6to4 transition"),
  v6Range("3fff::", 20, "documentation"),
  v6Range("fc00::", 7, "unique-local"),
  v6Range("fe80::", 10, "link-local"),
  v6Range("fec0::", 10, "reserved site-local"),
  v6Range("ff00::", 8, "multicast"),
] as const;

function normalizeRule(rule: EgressAllowRule): NormalizedAllowRule {
  if (!rule || !Array.isArray(rule.ports) || rule.ports.length === 0) {
    throw configurationError("each allow rule requires one or more explicit ports");
  }
  const hostname = normalizeRuleHostname(rule.hostname);
  const ports = new Set<number>();
  for (const port of rule.ports) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw configurationError("allow-rule ports must be integers from 1 to 65535");
    }
    ports.add(port);
  }
  return Object.freeze({ hostname, ports });
}

function normalizeRuleHostname(raw: string): string {
  if (typeof raw !== "string" || !raw || raw.includes("*") || /[\s/@?#]/.test(raw)) {
    throw configurationError("allow-rule hostnames must be exact hostnames or IP literals");
  }
  const unbracketed = stripIpv6Brackets(raw);
  if (isIP(unbracketed) !== 0) return canonicalIpLiteral(unbracketed);
  let parsed: URL;
  try {
    parsed = new URL(`https://${raw}`);
  } catch (error) {
    throw configurationError("allow-rule hostname is invalid", error);
  }
  if (parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw configurationError("allow-rule hostname must not include a port, path, query, or credentials");
  }
  return canonicalHostname(parsed);
}

function normalizeLimits(overrides: Partial<EgressLimits> | undefined): Readonly<EgressLimits> {
  const limits: EgressLimits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const allowZero = name === "maxRedirects";
    if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
      throw configurationError(`${name} must be ${allowZero ? "non-negative" : "positive"}`);
    }
  }
  return Object.freeze(limits);
}

function canonicalUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new EgressPolicyError("invalid_url", "outbound request URL is invalid", { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EgressPolicyError("protocol_denied", `outbound protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new EgressPolicyError("credentials_denied", "outbound URLs must not contain credentials");
  }
  return url;
}

function canonicalHostname(url: URL): string {
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (!hostname) throw new EgressPolicyError("invalid_url", "outbound URL has no hostname");
  if (isIP(hostname) !== 0) return canonicalIpLiteral(hostname);
  const withoutRootDot = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!withoutRootDot) throw new EgressPolicyError("invalid_url", "outbound URL hostname is invalid");
  return withoutRootDot;
}

function canonicalIpLiteral(address: string): string {
  if (isIP(address) === 4) return address.split(".").map((part) => String(Number(part))).join(".");
  if (isIP(address) === 6) {
    const parsed = new URL(`https://[${address}]/`);
    return stripIpv6Brackets(parsed.hostname).toLowerCase();
  }
  throw new EgressPolicyError("invalid_url", "invalid IP literal");
}

function canonicalMethod(method: string): string {
  const canonical = typeof method === "string" ? method.trim().toUpperCase() : "";
  if (!HTTP_METHOD_PATTERN.test(canonical)) {
    throw new EgressPolicyError("invalid_url", "outbound HTTP method is invalid");
  }
  return canonical;
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw configurationError("clock returned an invalid timestamp");
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new EgressPolicyError("invalid_configuration", `${label} exceeds safe range`);
  return value;
}

function configurationError(message: string, cause?: unknown): EgressPolicyError {
  return new EgressPolicyError("invalid_configuration", message, cause === undefined ? undefined : { cause });
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function v4Range(address: string, prefix: number, reason: string) {
  return { base: ipv4ToNumber(address), prefix, reason } as const;
}

function v6Range(address: string, prefix: number, reason: string) {
  return { base: ipv6ToBigInt(address), prefix, reason } as const;
}

function ipv4ToNumber(address: string): number {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new EgressPolicyError("resolution_failed", "invalid IPv4 address");
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InPrefix(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6ToBigInt(address: string): bigint {
  if (isIP(address) !== 6 || address.includes("%")) {
    throw new EgressPolicyError("resolution_failed", "invalid IPv6 address");
  }
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) throw new EgressPolicyError("resolution_failed", "invalid IPv6 address");
  const left = parseIpv6Part(halves[0]);
  const right = halves.length === 2 ? parseIpv6Part(halves[1]) : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new EgressPolicyError("resolution_failed", "invalid IPv6 address");
  }
  const hextets = halves.length === 1 ? left : [...left, ...Array(missing).fill(0), ...right];
  return hextets.reduce((value, hextet) => (value << 16n) | BigInt(hextet), 0n);
}

function parseIpv6Part(part: string): number[] {
  if (!part) return [];
  const tokens = part.split(":");
  const last = tokens.at(-1);
  if (last?.includes(".")) {
    const value = ipv4ToNumber(last);
    tokens.splice(tokens.length - 1, 1, ((value >>> 16) & 0xffff).toString(16), (value & 0xffff).toString(16));
  }
  return tokens.map((token) => {
    const value = Number.parseInt(token, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(token) || !Number.isInteger(value)) {
      throw new EgressPolicyError("resolution_failed", "invalid IPv6 address");
    }
    return value;
  });
}

function bigIntInPrefix(value: bigint, base: bigint, prefix: number, bits: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
}
