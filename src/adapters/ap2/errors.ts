export type Ap2AdapterErrorCode =
  | "artifact_malformed"
  | "binding_mismatch"
  | "profile_mismatch"
  | "schema_invalid"
  | "signature_invalid"
  | "time_invalid"
  | "untrusted_key";

/** Fail-closed adapter error with a stable, non-secret classification. */
export class Ap2AdapterError extends Error {
  constructor(
    message: string,
    readonly code: Ap2AdapterErrorCode
  ) {
    super(message);
    this.name = "Ap2AdapterError";
  }
}
