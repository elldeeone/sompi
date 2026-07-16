import * as os from "node:os";
import * as path from "node:path";

import { loadAgentApiCredential, type AgentApiCredential } from "./credential.js";

export interface PurchaseApiConnectionConfig {
  readonly baseUrl: string;
  readonly credential: AgentApiCredential;
}

export interface PurchaseApiListenerConfig extends PurchaseApiConnectionConfig {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
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
  const host = env.SOMPI_API_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new PurchaseApiConfigError("Sompi API host must be loopback");
  const port = numeric(env.SOMPI_API_PORT ?? "7442", "Sompi API port", 1, 65_535);
  const expectedOwnerUserId = numeric(required(env, "SOMPI_OPERATOR_UID"), "operator user ID", 0, 0x7fffffff);
  const runtimeGroupId = numeric(required(env, "SOMPI_RUNTIME_GID"), "runtime group ID", 0, 0x7fffffff);
  const filename = path.resolve(env.SOMPI_AGENT_API_CREDENTIAL ?? path.join(os.homedir(), ".sompi", "agent-api.json"));
  try {
    return Object.freeze({
      baseUrl: `http://${host === "::1" ? "[::1]" : host}:${port}`,
      credential: loadAgentApiCredential(filename, {
        expectedOwnerUserId,
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
  const connection = purchaseApiConnectionConfigFromEnv(env, options);
  const url = new URL(connection.baseUrl);
  return Object.freeze({
    ...connection,
    host: (url.hostname === "[::1]" || url.hostname === "::1" ? "::1" : "127.0.0.1") as "127.0.0.1" | "::1",
    port: Number(url.port),
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
