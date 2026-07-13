/**
 * Immutable spending policy enforced below the Agent. Operator Provisioning
 * validates and installs the source manifest; this module receives one typed
 * projection for its complete process lifetime.
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

export class PolicyEngine {
  private readonly configuredPolicy: Readonly<Policy>;

  constructor(policy: Readonly<Policy>) {
    if (
      typeof policy?.maxSompiPerTx !== "bigint" ||
      typeof policy?.maxSompiPerHour !== "bigint" ||
      typeof policy?.requireApprovalAboveSompi !== "bigint" ||
      !Array.isArray(policy?.allowlist) ||
      policy.allowlist.some((entry) => typeof entry !== "string") ||
      new Set(policy.allowlist).size !== policy.allowlist.length ||
      policy.maxSompiPerTx <= 0n ||
      policy.maxSompiPerHour <= 0n ||
      policy.maxSompiPerTx > policy.maxSompiPerHour ||
      policy.requireApprovalAboveSompi < 0n
    ) {
      throw new PolicyViolation("immutable operator policy is invalid");
    }
    this.configuredPolicy = Object.freeze({
      maxSompiPerTx: policy.maxSompiPerTx,
      maxSompiPerHour: policy.maxSompiPerHour,
      allowlist: Object.freeze([...policy.allowlist]) as unknown as string[],
      requireApprovalAboveSompi: policy.requireApprovalAboveSompi,
    });
  }

  get policy(): Readonly<Policy> {
    return this.configuredPolicy;
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
          `adjust the Operator Manifest — do not work around this tool yourself`
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
  ". This limit was set deliberately by your human operator. Do not replace the Operator Manifest, restart processes, " +
  "or bypass these tools with direct scripts to get around it — report this message to your operator and let " +
  "them decide";

export class PolicyViolation extends Error {
  constructor(reason: string) {
    super(`policy violation: ${reason}`);
    this.name = "PolicyViolation";
  }
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
