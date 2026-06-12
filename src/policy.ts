import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Spending policy enforced below the agent. The agent (LLM) can call
 * send_payment, but every send passes through this gate. The policy file
 * lives outside the MCP tool surface, so a prompt-injected agent cannot
 * loosen its own limits.
 */
export interface Policy {
  /** Hard cap per transaction, in sompi. */
  maxSompiPerTx: bigint;
  /** Rolling 1-hour spend cap, in sompi. */
  maxSompiPerHour: bigint;
  /** If non-empty, only these destination addresses may receive funds. */
  allowlist: string[];
  /** Sends above this amount are rejected with a message telling the agent
   *  to ask its human operator to send manually. 0 disables the threshold. */
  requireApprovalAboveSompi: bigint;
}

interface PolicyFileShape {
  maxSompiPerTx?: string | number;
  maxSompiPerHour?: string | number;
  allowlist?: string[];
  requireApprovalAboveSompi?: string | number;
}

interface SpendRecord {
  timestampMs: number;
  amountSompi: string;
}

const DEFAULT_POLICY: Policy = {
  // 1 KAS per tx, 5 KAS per hour: deliberately conservative defaults
  // suitable for testnet experimentation.
  maxSompiPerTx: 100_000_000n,
  maxSompiPerHour: 500_000_000n,
  allowlist: [],
  requireApprovalAboveSompi: 0n,
};

export class PolicyEngine {
  private readonly policyPath?: string;
  private readonly spendLogPath: string;
  private spendLog: SpendRecord[] = [];
  private cachedPolicy: Policy;
  private cachedMtimeMs = -1;
  private loadError?: string;

  constructor(dataDir: string, policyPath?: string) {
    this.policyPath = policyPath;
    this.cachedPolicy = loadPolicy(policyPath);
    if (policyPath) this.cachedMtimeMs = fs.statSync(policyPath).mtimeMs;
    this.spendLogPath = path.join(dataDir, "spend-log.json");
    if (fs.existsSync(this.spendLogPath)) {
      try {
        this.spendLog = JSON.parse(fs.readFileSync(this.spendLogPath, "utf8"));
      } catch {
        this.spendLog = [];
      }
    }
  }

  /**
   * The active policy, hot-reloaded: edits to the policy file take effect on
   * the next call, no restart needed. A malformed file fails closed — sends
   * are denied until it parses again.
   */
  get policy(): Policy {
    if (this.policyPath) {
      try {
        const mtimeMs = fs.statSync(this.policyPath).mtimeMs;
        if (mtimeMs !== this.cachedMtimeMs) {
          this.cachedPolicy = loadPolicy(this.policyPath);
          this.cachedMtimeMs = mtimeMs;
          this.loadError = undefined;
          console.error(`sompi: policy reloaded from ${this.policyPath}`);
        }
      } catch (e) {
        this.loadError = e instanceof Error ? e.message : String(e);
      }
    }
    if (this.loadError) {
      throw new PolicyViolation(
        `policy file ${this.policyPath} is unreadable or malformed (${this.loadError}); ` +
          `all sends are denied until it is fixed`
      );
    }
    return this.cachedPolicy;
  }

  /** Sum of sends in the trailing hour, in sompi. */
  spentLastHour(now = Date.now()): bigint {
    const cutoff = now - 60 * 60 * 1000;
    return this.spendLog
      .filter((r) => r.timestampMs >= cutoff)
      .reduce((acc, r) => acc + BigInt(r.amountSompi), 0n);
  }

  /** Throws with an agent-readable reason if the send is not permitted. */
  authorize(destination: string, amountSompi: bigint): void {
    const p = this.policy;
    if (amountSompi <= 0n) {
      throw new PolicyViolation("amount must be positive");
    }
    if (amountSompi > p.maxSompiPerTx) {
      throw new PolicyViolation(
        `amount ${amountSompi} sompi exceeds per-transaction limit of ${p.maxSompiPerTx} sompi` + OPERATOR_BOUNDARY
      );
    }
    if (p.requireApprovalAboveSompi > 0n && amountSompi > p.requireApprovalAboveSompi) {
      throw new PolicyViolation(
        `amount ${amountSompi} sompi exceeds the approval threshold of ${p.requireApprovalAboveSompi} sompi. ` +
          `Relay this to your human operator and wait for them to either perform the payment themselves or ` +
          `adjust the policy — do not edit the policy file or work around this tool yourself`
      );
    }
    if (p.allowlist.length > 0 && !p.allowlist.includes(destination)) {
      throw new PolicyViolation(
        `destination ${destination} is not on the policy allowlist` + OPERATOR_BOUNDARY
      );
    }
    const spent = this.spentLastHour();
    if (spent + amountSompi > p.maxSompiPerHour) {
      throw new PolicyViolation(
        `send of ${amountSompi} sompi would exceed the rolling hourly limit ` +
          `(${spent} of ${p.maxSompiPerHour} sompi already spent in the last hour)` + OPERATOR_BOUNDARY
      );
    }
  }

  /** Record a completed send against the rolling-hour budget. */
  record(amountSompi: bigint, now = Date.now()): void {
    const cutoff = now - 60 * 60 * 1000;
    this.spendLog = this.spendLog.filter((r) => r.timestampMs >= cutoff);
    this.spendLog.push({ timestampMs: now, amountSompi: amountSompi.toString() });
    fs.writeFileSync(this.spendLogPath, JSON.stringify(this.spendLog), { mode: 0o600 });
  }

  describe(): Record<string, string | string[]> {
    return {
      maxSompiPerTx: this.policy.maxSompiPerTx.toString(),
      maxSompiPerHour: this.policy.maxSompiPerHour.toString(),
      spentLastHourSompi: this.spentLastHour().toString(),
      allowlist: this.policy.allowlist,
      requireApprovalAboveSompi: this.policy.requireApprovalAboveSompi.toString(),
    };
  }
}

/**
 * Appended to policy denials so agents treat them as boundaries to report,
 * not obstacles to engineer around. This is the agent-facing contract: the
 * policy belongs to the human operator.
 */
const OPERATOR_BOUNDARY =
  ". This limit was set deliberately by your human operator. Do not edit the policy file, restart processes, " +
  "or bypass these tools with direct scripts to get around it — report this message to your operator and let " +
  "them decide";

export class PolicyViolation extends Error {
  constructor(reason: string) {
    super(`policy violation: ${reason}`);
    this.name = "PolicyViolation";
  }
}

function loadPolicy(policyPath?: string): Policy {
  if (!policyPath) return { ...DEFAULT_POLICY };
  const raw: PolicyFileShape = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  return {
    maxSompiPerTx: toBigInt(raw.maxSompiPerTx, DEFAULT_POLICY.maxSompiPerTx),
    maxSompiPerHour: toBigInt(raw.maxSompiPerHour, DEFAULT_POLICY.maxSompiPerHour),
    allowlist: raw.allowlist ?? [],
    requireApprovalAboveSompi: toBigInt(
      raw.requireApprovalAboveSompi,
      DEFAULT_POLICY.requireApprovalAboveSompi
    ),
  };
}

function toBigInt(v: string | number | undefined, fallback: bigint): bigint {
  if (v === undefined) return fallback;
  return BigInt(v);
}
