import { displayKas } from "./amount-display.js";

/** One immutable spending-policy revision enforced below the Agent. */
export interface Policy {
  /** Hard cap per transaction, in sompi. */
  maxSompiPerTx: bigint;
  /** Rolling 1-hour spend cap, in sompi. */
  maxSompiPerHour: bigint;
  /** If non-empty, only these destination addresses may receive funds. */
  allowlist: string[];
}

export class PolicyEngine {
  private configuredPolicy: Readonly<Policy>;

  constructor(policy: Readonly<Policy>) {
    this.configuredPolicy = validatePolicy(policy);
  }

  /** Activate one already-authorized immutable policy revision. */
  activate(policy: Readonly<Policy>): Readonly<Policy> {
    this.configuredPolicy = validatePolicy(policy);
    return this.configuredPolicy;
  }

  get policy(): Readonly<Policy> {
    return this.configuredPolicy;
  }

  /**
   * Throws when a movement is not permitted. `committedCapacitySompi` comes
   * from durable Purchase and Treasury Operation journals; policy no longer
   * maintains a competing JSON spend log.
   */
  authorize(
    destination: string,
    amountSompi: bigint,
    committedCapacitySompi = 0n,
  ): void {
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
    };
  }
}

function validatePolicy(policy: Readonly<Policy>): Readonly<Policy> {
    if (
      typeof policy?.maxSompiPerTx !== "bigint" ||
      typeof policy?.maxSompiPerHour !== "bigint" ||
      !Array.isArray(policy?.allowlist) ||
      policy.allowlist.some((entry) => typeof entry !== "string") ||
      new Set(policy.allowlist).size !== policy.allowlist.length ||
      policy.maxSompiPerTx <= 0n ||
      policy.maxSompiPerHour <= 0n ||
      policy.maxSompiPerTx > policy.maxSompiPerHour
    ) {
      throw new PolicyViolation("spending policy revision is invalid");
    }
    return Object.freeze({
      maxSompiPerTx: policy.maxSompiPerTx,
      maxSompiPerHour: policy.maxSompiPerHour,
      allowlist: Object.freeze([...policy.allowlist]) as unknown as string[],
    });
}

/**
 * Appended to policy denials so agents treat them as boundaries to report,
 * not obstacles to engineer around. This is the agent-facing contract: the
 * policy belongs to the human operator.
 */
const OPERATOR_BOUNDARY =
  ". This limit belongs to the wallet owner. Do not bypass Sompi or replace local state to get around it — " +
  "report the limit and let the owner approve an exact limit change if they want one";

export class PolicyViolation extends Error {
  constructor(reason: string) {
    super(`policy violation: ${reason}`);
    this.name = "PolicyViolation";
  }
}

function displayAmount(sompi: bigint): string {
  return displayKas(sompi);
}
