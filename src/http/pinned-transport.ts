import type { SafeTransportHop } from "../purchase/egress-policy.js";

export interface PinnedHttpTransportRequest {
  /** Connect only through this already-resolved and policy-approved hop. */
  readonly hop: SafeTransportHop;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
}

export interface PinnedHttpTransportResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: AsyncIterable<Uint8Array>;
}

export interface PinnedHttpTransport {
  send(request: Readonly<PinnedHttpTransportRequest>): Promise<PinnedHttpTransportResponse>;
}
