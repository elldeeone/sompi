import * as os from "node:os";
import * as path from "node:path";

import {
  loadAgentApiCredential,
  loadRecoveryApiCredential,
  type AgentApiCredential,
  type RecoveryApiCredential,
} from "./credential.js";
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

export interface PurchaseRecoveryApiListenerConfig {
  readonly socketPath: string;
  readonly expectedServerUserId: number;
  readonly runtimeGroupId: number;
  readonly credential: RecoveryApiCredential;
  readonly deadlineMs: number;
  readonly maxControlConcurrency: number;
  readonly maxConnections: number;
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

export function purchaseRecoveryApiListenerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ allowSameUserForTests?: boolean }> = {}
): PurchaseRecoveryApiListenerConfig {
  const configuredSocketPath = required(env, "SOMPI_RECOVERY_API_SOCKET");
  try {
    validatePurchaseApiSocketPath(configuredSocketPath);
  } catch (cause) {
    throw new PurchaseApiConfigError("Sompi recovery API socket path is invalid", { cause });
  }
  const operatorUserId = numeric(required(env, "SOMPI_OPERATOR_UID"), "operator user ID", 0, 0x7fffffff);
  const expectedServerUserId = numeric(required(env, "SOMPI_API_UID"), "API server user ID", 0, 0x7fffffff);
  const runtimeGroupId = numeric(required(env, "SOMPI_RECOVERY_GID"), "recovery group ID", 0, 0x7fffffff);
  const agentRuntimeGroupId = numeric(required(env, "SOMPI_RUNTIME_GID"), "runtime group ID", 0, 0x7fffffff);
  const socketPath = path.resolve(configuredSocketPath);
  if (socketPath === path.resolve(required(env, "SOMPI_API_SOCKET"))) {
    throw new PurchaseApiConfigError("Sompi recovery API requires a distinct socket path");
  }
  if (!options.allowSameUserForTests && runtimeGroupId === agentRuntimeGroupId) {
    throw new PurchaseApiConfigError("Sompi recovery API requires a distinct operator-only group");
  }
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!options.allowSameUserForTests && currentUserId !== expectedServerUserId) {
    throw new PurchaseApiConfigError("Sompi recovery API server must run as the configured API user");
  }
  const filename = path.resolve(required(env, "SOMPI_RECOVERY_API_CREDENTIAL"));
  try {
    return Object.freeze({
      socketPath,
      expectedServerUserId,
      runtimeGroupId,
      credential: loadRecoveryApiCredential(filename, {
        expectedOwnerUserId: operatorUserId,
        runtimeGroupId,
        ...(options.allowSameUserForTests ? { allowSameUserForTests: true } : {}),
      }),
      deadlineMs: numeric(env.SOMPI_RECOVERY_API_DEADLINE_MS ?? "120000", "Sompi recovery API deadline", 1_000, 600_000),
      maxControlConcurrency: numeric(env.SOMPI_RECOVERY_API_MAX_CONCURRENCY ?? "2", "Sompi recovery API concurrency", 1, 16),
      maxConnections: numeric(env.SOMPI_RECOVERY_API_MAX_CONNECTIONS ?? "8", "Sompi recovery API connection limit", 1, 64),
    });
  } catch (cause) {
    if (cause instanceof PurchaseApiConfigError) throw cause;
    throw new PurchaseApiConfigError("Sompi recovery API credential is unavailable", { cause });
  }
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
