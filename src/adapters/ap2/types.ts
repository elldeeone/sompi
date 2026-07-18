export type Ap2SigningRole = "authority";

export interface P256PublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly alg?: "ES256";
  readonly kid?: string;
  readonly use?: "sig";
  readonly key_ops?: readonly string[];
}

export interface P256PrivateJwk extends P256PublicJwk {
  readonly d: string;
}

export interface Ap2PublicTrustEntry {
  readonly role: Ap2SigningRole;
  readonly issuer: string;
  readonly kid: string;
  readonly publicJwk: P256PublicJwk;
}

export interface Ap2SigningIdentity {
  readonly role: Ap2SigningRole;
  readonly issuer: string;
  readonly kid: string;
  readonly privateJwk: P256PrivateJwk;
}

export interface Ap2PublicKeyResolver {
  resolve(
    role: Ap2SigningRole,
    issuer: string,
    kid: string,
  ): P256PublicJwk | undefined | Promise<P256PublicJwk | undefined>;
}

export interface Ap2VerificationClock {
  /** Unix epoch seconds. Defaults to the current system clock. */
  readonly nowSec?: number;
  /** Bounded allowance for clock disagreement. Defaults to 30 seconds. */
  readonly clockSkewSec?: number;
}
