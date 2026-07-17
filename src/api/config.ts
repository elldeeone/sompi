import * as os from "node:os";
import * as path from "node:path";

import { loadAgentApiCredential, type AgentApiCredential } from "./credential.js";
import { validatePurchaseApiSocketPath } from "./socket.js";

export interface PurchaseApiConnectionConfig {
  readonly socketPath: string;
  readonly expectedServerUserId: number;
  readonly runtimeGroupId: number;
  readonly credential: AgentApiCredential;
}

export interface PurchaseApiListenerConfig extends PurchaseApiConnectionConfig {
  readonly deadlineMs: number;
  readonly maxPurchaseConcurrency: number;
  readonly maxControlConcurrency: number;
}

export class PurchaseApiConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PurchaseApiConfigError";
  }
}

export function purchaseApiConnectionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ allowSameUserForTests?: boolean }> = {}
): PurchaseApiConnectionConfig {
  return purchaseApiConfigFromEnv(env, options, true);
}

function purchaseApiConfigFromEnv(
  env: NodeJS.ProcessEnv,
  options: Readonly<{ allowSameUserForTests?: boolean }>,
  requireDistinctClient: boolean
): PurchaseApiConnectionConfig {
  if (env.SOMPI_API_HOST !== undefined || env.SOMPI_API_PORT !== undefined) {
    throw new PurchaseApiConfigError("SOMPI_API_HOST and SOMPI_API_PORT were removed; configure SOMPI_API_SOCKET");
  }
  const configuredSocketPath = required(env, "SOMPI_API_SOCKET");
  try {
    validatePurchaseApiSocketPath(configuredSocketPath);
  } catch (cause) {
    throw new PurchaseApiConfigError("Sompi API socket path is invalid", { cause });
  }
  const socketPath = path.resolve(configuredSocketPath);
  const operatorUserId = numeric(required(env, "SOMPI_OPERATOR_UID"), "operator user ID", 0, 0x7fffffff);
  const expectedServerUserId = numeric(required(env, "SOMPI_API_UID"), "API server user ID", 0, 0x7fffffff);
  const runtimeGroupId = numeric(required(env, "SOMPI_RUNTIME_GID"), "runtime group ID", 0, 0x7fffffff);
  if (requireDistinctClient && !options.allowSameUserForTests) {
    const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      currentUserId === undefined ||
      currentUserId === 0 ||
      currentUserId === expectedServerUserId ||
      currentUserId === operatorUserId
    ) {
      throw new PurchaseApiConfigError(
        "Sompi API clients must run as a distinct non-root runtime principal",
      );
    }
  }
  const filename = path.resolve(env.SOMPI_AGENT_API_CREDENTIAL ?? path.join(os.homedir(), ".sompi", "agent-api.json"));
  try {
    return Object.freeze({
      socketPath,
      expectedServerUserId,
      runtimeGroupId,
      credential: loadAgentApiCredential(filename, {
        expectedOwnerUserId: operatorUserId,
        runtimeGroupId,
        ...(options.allowSameUserForTests ? { allowSameUserForTests: true } : {}),
      }),
    });
  } catch (cause) {
    throw new PurchaseApiConfigError("Sompi agent API credential is unavailable", { cause });
  }
}

export function purchaseApiListenerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ allowSameUserForTests?: boolean }> = {}
): PurchaseApiListenerConfig {
  const connection = purchaseApiConfigFromEnv(env, options, false);
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!options.allowSameUserForTests && currentUserId !== connection.expectedServerUserId) {
    throw new PurchaseApiConfigError("Sompi API server must run as the configured operator user");
  }
  return Object.freeze({
    ...connection,
    deadlineMs: numeric(env.SOMPI_API_DEADLINE_MS ?? "120000", "Sompi API deadline", 1_000, 600_000),
    maxPurchaseConcurrency: numeric(
      env.SOMPI_API_MAX_PURCHASE_CONCURRENCY ?? "8",
      "Sompi API Purchase concurrency",
      1,
      64
    ),
    maxControlConcurrency: numeric(
      env.SOMPI_API_MAX_CONTROL_CONCURRENCY ?? "2",
      "Sompi API control concurrency",
      1,
      16
    ),
  });
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new PurchaseApiConfigError(`${name} is required`);
  return value;
}

function numeric(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new PurchaseApiConfigError(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new PurchaseApiConfigError(`${label} is invalid`);
  return parsed;
}
