import * as http from "node:http";

import {
  MAX_SOMPI_API_RESPONSE_BYTES,
  SompiApiContractError,
  assertSompiApiError,
  assertPurchaseView,
  assertTransferId,
  assertTransferView,
  assertWalletActivity,
  assertWalletView,
  assertPolicyChangeId,
  assertPolicyChangeView,
  assertVaultMigrationId,
  assertVaultMigrationView,
  assertWalletTechnicalView,
  parsePurchaseCreateRequest,
  parseTransferCreateRequest,
  parsePolicyChangeCreateRequest,
  parseVaultMigrationCreateRequest,
  type SompiApplication,
  type PurchaseCreateRequest,
  type TransferCreateRequest,
  type PolicyChangeCreateRequest,
  type VaultMigrationCreateRequest,
} from "./contracts.js";
import type { AgentApiCredential } from "./credential.js";
import {
  verifySompiApiSocketForClient,
  type SompiApiSocketAccess,
} from "./socket.js";
import type { PurchaseView } from "../purchase/types.js";
import type { TransferView } from "../transfer/types.js";
import type { WalletActivityItem, WalletTechnicalView, WalletView } from "../wallet-view/module.js";
import { assertPurchaseId } from "../purchase/identity.js";
import type { PolicyChangeView } from "../policy-change/types.js";
import type { VaultMigrationView } from "../vault-migration/types.js";

export interface SompiApiClientOptions extends SompiApiSocketAccess {
  readonly socketPath: string;
  readonly credential: AgentApiCredential;
  readonly timeoutMs?: number;
}

export class SompiApiClientError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SompiApiClientError";
  }
}

/** Thin client used by MCP; it has no wallet, Journal, Authority, or protocol capability. */
export class SompiApiClient implements SompiApplication {
  private readonly socketPath: string;
  private readonly socketAccess: SompiApiSocketAccess;
  private readonly credential: AgentApiCredential;
  private readonly timeoutMs: number;

  constructor(options: SompiApiClientOptions) {
    this.socketPath = options.socketPath;
    this.socketAccess = Object.freeze({
      expectedServerUserId: options.expectedServerUserId,
      runtimeGroupId: options.runtimeGroupId,
    });
    this.credential = options.credential;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 125_000);
  }

  purchase(input: PurchaseCreateRequest, signal?: AbortSignal): Promise<PurchaseView> {
    return this.request("POST", "/purchases", parsePurchaseCreateRequest(input), assertPurchaseView, signal);
  }

  status(purchaseId: string, signal?: AbortSignal): Promise<PurchaseView> {
    return this.request("GET", `/purchases/${assertPurchaseId(purchaseId)}`, undefined, assertPurchaseView, signal);
  }

  recover(purchaseId: string, signal?: AbortSignal): Promise<PurchaseView> {
    return this.request("POST", `/purchases/${assertPurchaseId(purchaseId)}/recover`, undefined, assertPurchaseView, signal);
  }

  wallet(signal?: AbortSignal): Promise<WalletView> {
    return this.request("GET", "/wallet", undefined, assertWalletView, signal);
  }

  walletTechnical(signal?: AbortSignal): Promise<WalletTechnicalView> {
    return this.request("GET", "/wallet/technical", undefined, assertWalletTechnicalView, signal);
  }

  activity(limit = 20, signal?: AbortSignal): Promise<readonly WalletActivityItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SompiApiClientError("INVALID_REQUEST", "Wallet activity limit must be between 1 and 100.", false);
    }
    return this.request("GET", `/wallet/activity?limit=${limit}`, undefined, assertWalletActivity, signal);
  }

  transfer(input: TransferCreateRequest, signal?: AbortSignal): Promise<TransferView> {
    return this.request("POST", "/transfers", parseTransferCreateRequest(input), assertTransferView, signal);
  }

  transferStatus(transferId: string, signal?: AbortSignal): Promise<TransferView> {
    return this.request("GET", `/transfers/${assertTransferId(transferId)}`, undefined, assertTransferView, signal);
  }

  transferRecover(transferId: string, signal?: AbortSignal): Promise<TransferView> {
    return this.request("POST", `/transfers/${assertTransferId(transferId)}/recover`, undefined, assertTransferView, signal);
  }

  changePolicy(input: PolicyChangeCreateRequest, signal?: AbortSignal): Promise<PolicyChangeView> {
    return this.request(
      "POST",
      "/policy-changes",
      parsePolicyChangeCreateRequest(input),
      assertPolicyChangeView,
      signal,
    );
  }

  policyChangeStatus(policyChangeId: string, signal?: AbortSignal): Promise<PolicyChangeView> {
    return this.request(
      "GET",
      `/policy-changes/${assertPolicyChangeId(policyChangeId)}`,
      undefined,
      assertPolicyChangeView,
      signal,
    );
  }

  policyChangeRecover(policyChangeId: string, signal?: AbortSignal): Promise<PolicyChangeView> {
    return this.request("POST", `/policy-changes/${assertPolicyChangeId(policyChangeId)}/recover`, undefined, assertPolicyChangeView, signal);
  }

  vaultMigration(input: VaultMigrationCreateRequest, signal?: AbortSignal): Promise<VaultMigrationView> {
    return this.request("POST", "/vault-migrations", parseVaultMigrationCreateRequest(input), assertVaultMigrationView, signal);
  }

  vaultMigrationStatus(vaultMigrationId: string, signal?: AbortSignal): Promise<VaultMigrationView> {
    return this.request("GET", `/vault-migrations/${assertVaultMigrationId(vaultMigrationId)}`, undefined, assertVaultMigrationView, signal);
  }

  private async request<T>(
    method: string,
    pathname: string,
    body: unknown,
    validate: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      verifySompiApiSocketForClient(this.socketPath, this.socketAccess);
    } catch (cause) {
      throw new SompiApiClientError(
        "API_UNAVAILABLE",
        "The local Sompi API socket is unavailable or has an invalid identity.",
        true,
        { cause }
      );
    }
    const bodyBytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: http.IncomingMessage;
    try {
      response = await sendRequest({
        socketPath: this.socketPath,
        method,
        pathname,
        credential: this.credential,
        body: bodyBytes,
        signal: combined,
      });
    } catch (cause) {
      throw new SompiApiClientError(
        timeout.aborted ? "DEADLINE_EXCEEDED" : "API_UNAVAILABLE",
        timeout.aborted ? "The local Sompi API deadline elapsed." : "The local Sompi API is unavailable.",
        true,
        { cause }
      );
    } finally {
      bodyBytes?.fill(0);
    }
    const contentType = firstHeader(response.headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      response.destroy();
      throw new SompiApiClientError("INVALID_API_RESPONSE", "The local Sompi API returned an invalid content type.", false);
    }
    const declared = firstHeader(response.headers["content-length"]);
    if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_SOMPI_API_RESPONSE_BYTES)) {
      response.destroy();
      throw new SompiApiClientError("INVALID_API_RESPONSE", "The local Sompi API response exceeds the size limit.", false);
    }
    const bytes = await readBoundedResponse(response, MAX_SOMPI_API_RESPONSE_BYTES);
    if (bytes.byteLength === 0) {
      throw new SompiApiClientError("INVALID_API_RESPONSE", "The local Sompi API response size is invalid.", false);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (cause) {
      throw new SompiApiClientError("INVALID_API_RESPONSE", "The local Sompi API returned invalid JSON.", false, { cause });
    } finally {
      bytes.fill(0);
    }
    try {
      const status = response.statusCode ?? 0;
      if (status >= 200 && status < 300) return validate(value);
      const error = assertSompiApiError(value).error;
      throw new SompiApiClientError(error.code, error.message, error.retryable);
    } catch (cause) {
      if (cause instanceof SompiApiClientError) throw cause;
      if (cause instanceof SompiApiContractError) {
        throw new SompiApiClientError("INVALID_API_RESPONSE", "The local Sompi API response violates its contract.", false, { cause });
      }
      throw cause;
    }
  }
}

function sendRequest(input: Readonly<{
  socketPath: string;
  method: string;
  pathname: string;
  credential: AgentApiCredential;
  body: Buffer | undefined;
  signal: AbortSignal;
}>): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: input.socketPath,
      path: input.pathname,
      method: input.method,
      signal: input.signal,
      headers: {
        host: "sompi.local",
        authorization: `Bearer ${input.credential.token}`,
        accept: "application/json",
        ...(input.body === undefined ? {} : {
          "content-type": "application/json",
          "content-length": String(input.body.byteLength),
        }),
      },
    });
    request.once("error", reject);
    request.once("response", resolve);
    request.end(input.body);
  });
}

async function readBoundedResponse(response: http.IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > limit) {
        response.destroy();
        throw new SompiApiClientError(
          "INVALID_API_RESPONSE",
          "The local Sompi API response exceeds the size limit.",
          false
        );
      }
      chunks.push(Buffer.from(chunk));
    }
    return Uint8Array.from(Buffer.concat(chunks, total));
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new SompiApiClientError("INVALID_CONFIGURATION", "Sompi API timeout is invalid.", false);
  return value;
}
