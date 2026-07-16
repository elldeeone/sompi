import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PurchaseApiClientError } from "../api/client.js";
import {
  PurchaseApiContractError,
  assertPurchaseView,
  type PurchaseApplication,
  type PurchaseCreateRequest,
} from "../api/contracts.js";

const PURCHASE_ID = z.string().regex(/^pur_[A-Za-z0-9_-]{22}$/);
const PURCHASE_REQUEST_KEY = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/);
const HTTP_METHOD = z.string().regex(/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/).default("GET");
const MAX_MCP_RESULT_BYTES = 64 * 1024;

export interface McpToolResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly isError?: boolean;
}

export interface McpRequestExtra {
  readonly signal: AbortSignal;
}

export interface McpToolRegistrar {
  registerTool(
    name: string,
    config: {
      readonly description: string;
      readonly inputSchema?: Readonly<Record<string, z.ZodTypeAny>>;
    },
    handler: (args: any, extra?: McpRequestExtra) => Promise<McpToolResult>
  ): unknown;
}

/** MCP is a stateless compatibility adapter over the canonical Purchase API. */
export function createSompiMcpServer(application: PurchaseApplication, version: string): McpServer {
  if (!version || version.length > 100) throw new Error("Sompi MCP version is invalid");
  const server = new McpServer({ name: "sompi", version });
  registerSompiTools({
    registerTool(name, config, handler) {
      (server as any).registerTool(name, config, handler);
    },
  }, application);
  return server;
}

export function registerSompiTools(registrar: McpToolRegistrar, application: PurchaseApplication): void {
  if (!registrar || typeof registrar.registerTool !== "function" || !application) {
    throw new Error("Sompi MCP dependencies are unavailable");
  }
  const register = (
    name: string,
    description: string,
    inputSchema: Readonly<Record<string, z.ZodTypeAny>>,
    operation: (args: any, signal: AbortSignal) => Promise<unknown>
  ): void => {
    registrar.registerTool(name, { description, inputSchema }, async (args, extra) => {
      const signal = extra?.signal ?? new AbortController().signal;
      try {
        return success(assertPurchaseView(await operation(args, signal)));
      } catch (error) {
        return safeFailure(error);
      }
    });
  };

  register(
    "purchase",
    "Create or idempotently resume a Sompi Purchase through the local Purchase API.",
    {
      requestKey: PURCHASE_REQUEST_KEY,
      url: z.string().url().max(2_048),
      method: HTTP_METHOD,
      bodyBase64: z.string().max(1_398_104).optional(),
      mediaType: z.string().min(1).max(200).optional(),
      expectedMerchant: z.object({
        id: z.string().min(1).max(256).optional(),
        origin: z.string().url().max(2_048).optional(),
      }).strict().optional(),
    },
    (args: PurchaseCreateRequest, signal) => application.purchase(args, signal)
  );
  register(
    "purchase_status",
    "Read one durable Sompi Purchase without performing an external side effect.",
    { purchaseId: PURCHASE_ID },
    ({ purchaseId }: { purchaseId: string }, signal) => application.status(purchaseId, signal)
  );
  register(
    "purchase_recover",
    "Reconcile one interrupted Purchase without blindly repeating payment.",
    { purchaseId: PURCHASE_ID },
    ({ purchaseId }: { purchaseId: string }, signal) => application.recover(purchaseId, signal)
  );
}

function success(value: unknown): McpToolResult {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_MCP_RESULT_BYTES) {
    return failure("INVALID_API_RESPONSE", "The Purchase response exceeds the MCP compatibility limit.", false);
  }
  return { content: [{ type: "text", text }] };
}

function safeFailure(error: unknown): McpToolResult {
  if (error instanceof PurchaseApiClientError) {
    return failure(error.code, boundedMessage(error.message), error.retryable);
  }
  if (error instanceof PurchaseApiContractError) {
    return failure("INVALID_REQUEST", "The request does not match the Purchase contract.", false);
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return failure("REQUEST_CANCELLED", "The request was cancelled; inspect Purchase status before retrying.", true);
  }
  return failure("PURCHASE_API_FAILED", "The local Purchase API operation failed safely; ask the operator to inspect it.", false);
}

function failure(code: string, message: string, retryable: boolean): McpToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, retryable } }) }],
  };
}

function boundedMessage(value: string): string {
  return value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)
    ? "The local Purchase API operation failed safely."
    : value;
}
