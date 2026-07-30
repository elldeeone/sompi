import {
  JournalFencingError,
  type LeaseToken,
} from "../journal/contracts.js";
import type {
  TreasuryOperationJournal,
} from "./operation-journal.js";

interface TreasuryLeaseLifecycleOptions {
  readonly abortOnLoss?: boolean;
  readonly ignoreReleaseFencing?: boolean;
}

/**
 * Internal Treasury lease lifecycle.
 *
 * Durable Journal generations remain authoritative. This helper only keeps
 * one acquired generation live and applies one release policy.
 */
export class TreasuryLeaseLifecycle<
  Lease extends LeaseToken,
> {
  private currentLease: Lease;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly abortController?: AbortController;
  private lost = false;
  private loss: unknown;
  private released = false;

  constructor(
    private readonly journal: Pick<
      TreasuryOperationJournal,
      "renewLease" | "releaseLease"
    >,
    lease: Lease,
    private readonly ttlMs: number,
    private readonly options: TreasuryLeaseLifecycleOptions = {},
  ) {
    this.currentLease = lease;
    this.abortController = options.abortOnLoss
      ? new AbortController()
      : undefined;
    this.heartbeat = setInterval(() => {
      if (this.lost || this.released) return;
      try {
        this.renew();
      } catch (error) {
        this.lost = true;
        this.loss =
          error ??
          new JournalFencingError(
            "Treasury lease renewal failed without an error",
          );
        this.abortController?.abort();
      }
    }, Math.max(10, Math.floor(ttlMs / 3)));
    this.heartbeat.unref();
  }

  get lease(): Lease {
    return this.currentLease;
  }

  get leaseLost(): boolean {
    return this.lost;
  }

  get lossCause(): unknown {
    return this.loss;
  }

  get signal(): AbortSignal {
    if (!this.abortController) {
      throw new Error(
        "Treasury lease lifecycle has no abort signal",
      );
    }
    return this.abortController.signal;
  }

  renew(): Lease {
    if (this.lost) throw this.loss;
    this.currentLease = this.journal.renewLease(
      this.currentLease,
      this.ttlMs,
    ) as Lease;
    return this.currentLease;
  }

  release(): void {
    if (this.released) return;
    this.journal.releaseLease(this.currentLease);
    this.released = true;
  }

  close(): void {
    clearInterval(this.heartbeat);
    if (this.lost || this.released) return;
    try {
      this.release();
    } catch (error) {
      if (
        !this.options.ignoreReleaseFencing ||
        !(error instanceof JournalFencingError)
      ) {
        throw error;
      }
    }
  }
}
