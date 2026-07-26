import * as os from "node:os";
import * as path from "node:path";

import {
  loadAgentApiCredential,
  loadRecoveryApiCredential,
  type AgentApiCredential,
  type RecoveryApiCredential,
} from "./credential.js";
import {
  validateSompiApiSocketPath,
  type SompiApiSocketDirectoryMode,
} from "./socket.js";

export interface SompiApiConnectionConfig {
  readonly socketPath: string;
  readonly expectedServerUserId: number;
  readonly runtimeGroupId: number;
  readonly directoryMode: SompiApiSocketDirectoryMode;
  readonly credential: AgentApiCredential;
}

export interface SompiApiListenerConfig extends SompiApiConnectionConfig {
  readonly deadlineMs: number;
  readonly maxMutationConcurrency: number;
  readonly maxControlConcurrency: number;
}

export interface SompiRecoveryApiListenerConfig {
  readonly socketPath: string;
  readonly expectedServerUserId: number;
  readonly runtimeGroupId: number;
  readonly directoryMode: SompiApiSocketDirectoryMode;
  readonly credential: RecoveryApiCredential;
  readonly deadlineMs: number;
  readonly maxControlConcurrency: number;
  readonly maxConnections: number;
}

export class SompiApiConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SompiApiConfigError";
  }
}

export function sompiApiConnectionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ allowSameUserForTests?: boolean }> = {}
): SompiApiConnectionConfig {
  return sompiApiConfigFromEnv(env, options, true);
}

function sompiApiConfigFromEnv(
  env: NodeJS.ProcessEnv,
  options: Readonly<{ allowSameUserForTests?: boolean }>,
  requireDistinctClient: boolean
): SompiApiConnectionConfig {
  if (env.SOMPI_API_HOST !== undefined || env.SOMPI_API_PORT !== undefined) {
    throw new SompiApiConfigError("SOMPI_API_HOST and SOMPI_API_PORT were removed; configure SOMPI_API_SOCKET");
  }
  const configuredSocketPath = required(env, "SOMPI_API_SOCKET");
  try {
    validateSompiApiSocketPath(configuredSocketPath);
  } catch (cause) {
    throw new SompiApiConfigError("Sompi API socket path is invalid", { cause });
  }
  const socketPath = path.resolve(configuredSocketPath);
  const operatorUserId = numeric(required(env, "SOMPI_OPERATOR_UID"), "operator user ID", 0, 0x7fffffff);
  const expectedServerUserId = numeric(required(env, "SOMPI_API_UID"), "API server user ID", 0, 0x7fffffff);
  const credentialRuntimeGroupId = numeric(
    required(env, "SOMPI_RUNTIME_GID"),
    "runtime group ID",
    0,
    0x7fffffff,
  );
  const runtimeGroupId = numeric(
    required(env, "SOMPI_API_SOCKET_GID"),
    "API socket group ID",
    0,
    0x7fffffff,
  );
  assertAgentSocketGroupIsDistinct(
    credentialRuntimeGroupId,
    runtimeGroupId,
    options.allowSameUserForTests === true || requireDistinctClient,
  );
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  const currentGroupId = typeof process.getgid === "function" ? process.getgid() : undefined;
  if (requireDistinctClient && !options.allowSameUserForTests) {
    if (
      currentUserId === undefined ||
      currentGroupId === undefined ||
      currentUserId === 0 ||
      currentUserId === expectedServerUserId ||
      currentUserId === operatorUserId ||
      credentialRuntimeGroupId !== currentGroupId
    ) {
      throw new SompiApiConfigError(
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
      directoryMode: 0o2710,
      credential: loadAgentApiCredential(filename, {
        expectedOwnerUserId:
          requireDistinctClient && !options.allowSameUserForTests
            ? currentUserId!
            : operatorUserId,
        runtimeGroupId: credentialRuntimeGroupId,
        ...(requireDistinctClient && !options.allowSameUserForTests
          ? { ownerOnlyClientFile: true }
          : {}),
        ...(options.allowSameUserForTests ? { allowSameUserForTests: true } : {}),
      }),
    });
  } catch (cause) {
    throw new SompiApiConfigError("Sompi agent API credential is unavailable", { cause });
  }
}

export function sompiApiListenerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ allowSameUserForTests?: boolean }> = {}
): SompiApiListenerConfig {
  const connection = sompiApiConfigFromEnv(env, options, false);
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!options.allowSameUserForTests && currentUserId !== connection.expectedServerUserId) {
    throw new SompiApiConfigError("Sompi API server must run as the configured operator user");
  }
  return Object.freeze({
    ...connection,
    deadlineMs: numeric(env.SOMPI_API_DEADLINE_MS ?? "120000", "Sompi API deadline", 1_000, 600_000),
    maxMutationConcurrency: numeric(
      env.SOMPI_API_MAX_MUTATION_CONCURRENCY ?? "8",
      "Sompi API mutation concurrency",
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

export function sompiRecoveryApiListenerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ allowSameUserForTests?: boolean }> = {}
): SompiRecoveryApiListenerConfig {
  const configuredSocketPath = required(env, "SOMPI_RECOVERY_API_SOCKET");
  try {
    validateSompiApiSocketPath(configuredSocketPath);
  } catch (cause) {
    throw new SompiApiConfigError("Sompi recovery API socket path is invalid", { cause });
  }
  const operatorUserId = numeric(required(env, "SOMPI_OPERATOR_UID"), "operator user ID", 0, 0x7fffffff);
  const expectedServerUserId = numeric(required(env, "SOMPI_API_UID"), "API server user ID", 0, 0x7fffffff);
  const runtimeGroupId = numeric(required(env, "SOMPI_RECOVERY_GID"), "recovery group ID", 0, 0x7fffffff);
  const agentRuntimeGroupId = numeric(required(env, "SOMPI_RUNTIME_GID"), "runtime group ID", 0, 0x7fffffff);
  const agentSocketGroupId = numeric(
    required(env, "SOMPI_API_SOCKET_GID"),
    "API socket group ID",
    0,
    0x7fffffff,
  );
  assertAgentSocketGroupIsDistinct(
    agentRuntimeGroupId,
    agentSocketGroupId,
    options.allowSameUserForTests === true,
  );
  const socketPath = path.resolve(configuredSocketPath);
  if (socketPath === path.resolve(required(env, "SOMPI_API_SOCKET"))) {
    throw new SompiApiConfigError("Sompi recovery API requires a distinct socket path");
  }
  if (
    !options.allowSameUserForTests &&
    (runtimeGroupId === agentRuntimeGroupId || runtimeGroupId === agentSocketGroupId)
  ) {
    throw new SompiApiConfigError("Sompi recovery API requires a distinct operator-only group");
  }
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!options.allowSameUserForTests && currentUserId !== expectedServerUserId) {
    throw new SompiApiConfigError("Sompi recovery API server must run as the configured API user");
  }
  const filename = path.resolve(required(env, "SOMPI_RECOVERY_API_CREDENTIAL"));
  try {
    return Object.freeze({
      socketPath,
      expectedServerUserId,
      runtimeGroupId,
      directoryMode: 0o710,
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
    if (cause instanceof SompiApiConfigError) throw cause;
    throw new SompiApiConfigError("Sompi recovery API credential is unavailable", { cause });
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new SompiApiConfigError(`${name} is required`);
  return value;
}

function numeric(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new SompiApiConfigError(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new SompiApiConfigError(`${label} is invalid`);
  return parsed;
}

function assertAgentSocketGroupIsDistinct(
  credentialRuntimeGroupId: number,
  socketGroupId: number,
  allowSameUserForTests: boolean,
): void {
  if (!allowSameUserForTests && credentialRuntimeGroupId === socketGroupId) {
    throw new SompiApiConfigError(
      "Sompi API socket requires the selected agent's distinct primary group",
    );
  }
}
