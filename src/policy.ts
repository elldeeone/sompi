import * as fs from "node:fs";

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
  private cachedPolicy: Policy;
  private cachedMtimeMs = -1;
  private loadError?: string;

  constructor(_dataDir: string, policyPath?: string) {
    this.policyPath = policyPath;
    this.cachedPolicy = loadPolicy(policyPath);
    if (policyPath) this.cachedMtimeMs = fs.statSync(policyPath).mtimeMs;
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

  /**
   * Throws when a movement is not permitted. `committedCapacitySompi` comes
   * from durable Purchase and Treasury Operation journals; policy no longer
   * maintains a competing JSON spend log.
   */
  authorize(destination: string, amountSompi: bigint, committedCapacitySompi = 0n): void {
    const p = this.policy;
    if (amountSompi <= 0n) {
      throw new PolicyViolation("amount must be positive");
    }
    if (amountSompi > p.maxSompiPerTx) {
      throw new PolicyViolation(
        `amount ${displayAmount(amountSompi)} exceeds the per-payment limit of ${displayAmount(p.maxSompiPerTx)}` +
          OPERATOR_BOUNDARY
      );
    }
    if (p.requireApprovalAboveSompi > 0n && amountSompi > p.requireApprovalAboveSompi) {
      throw new PolicyViolation(
        `amount ${displayAmount(amountSompi)} exceeds the approval threshold of ${displayAmount(p.requireApprovalAboveSompi)}. ` +
          `Relay this to your human operator and wait for them to either perform the payment themselves or ` +
          `adjust the policy — do not edit the policy file or work around this tool yourself`
      );
    }
    if (p.allowlist.length > 0 && !p.allowlist.includes(destination)) {
      throw new PolicyViolation(
        `destination ${destination} is not on the policy allowlist` + OPERATOR_BOUNDARY
      );
    }
    if (committedCapacitySompi < 0n) {
      throw new PolicyViolation("durable Treasury capacity is invalid");
    }
    const spent = committedCapacitySompi;
    if (spent + amountSompi > p.maxSompiPerHour) {
      throw new PolicyViolation(
        `send of ${displayAmount(amountSompi)} would exceed the rolling hourly limit ` +
          `(${displayAmount(spent)} of ${displayAmount(p.maxSompiPerHour)} already spent in the last hour)` +
          OPERATOR_BOUNDARY
      );
    }
  }

  describe(): Record<string, string | string[]> {
    return {
      maxSompiPerTx: this.policy.maxSompiPerTx.toString(),
      maxSompiPerHour: this.policy.maxSompiPerHour.toString(),
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

function displayAmount(sompi: bigint): string {
  return `${formatKas(sompi)} KAS (${sompi} sompi)`;
}

function formatKas(sompi: bigint): string {
  const sign = sompi < 0n ? "-" : "";
  const absolute = sompi < 0n ? -sompi : sompi;
  const whole = absolute / 100_000_000n;
  const fraction = (absolute % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}
