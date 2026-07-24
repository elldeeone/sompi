import type { PolicyChangeView } from "../policy-change/types.js";
import { assertPurchaseId } from "../purchase/identity.js";
import type { PurchaseView } from "../purchase/types.js";
import type { TransferView } from "../transfer/types.js";
import type { VaultMigrationView } from "../vault-migration/types.js";
import type {
  WalletActivityItem,
  WalletTechnicalView,
  WalletView,
} from "../wallet-view/module.js";
import {
  POLICY_CHANGE_CREATE_REQUEST_SCHEMA,
  POLICY_CHANGE_VIEW_SCHEMA,
  PURCHASE_CREATE_REQUEST_SCHEMA,
  PURCHASE_VIEW_SCHEMA,
  TRANSFER_CREATE_REQUEST_SCHEMA,
  TRANSFER_VIEW_SCHEMA,
  VAULT_MIGRATION_CREATE_REQUEST_SCHEMA,
  VAULT_MIGRATION_VIEW_SCHEMA,
  WALLET_ACTIVITY_SCHEMA,
  WALLET_TECHNICAL_VIEW_SCHEMA,
  WALLET_VIEW_SCHEMA,
  SompiApiContractError,
  assertPolicyChangeId,
  assertPolicyChangeView,
  assertPurchaseView,
  assertTransferId,
  assertTransferView,
  assertVaultMigrationId,
  assertVaultMigrationView,
  assertWalletActivity,
  assertWalletTechnicalView,
  assertWalletView,
  parsePolicyChangeCreateRequest,
  parsePurchaseCreateRequest,
  parseTransferCreateRequest,
  parseVaultMigrationCreateRequest,
  type PolicyChangeCreateRequest,
  type PurchaseCreateRequest,
  type SompiApplication,
  type TransferCreateRequest,
  type VaultMigrationCreateRequest,
} from "./contracts.js";

type JsonSchema = Readonly<Record<string, unknown>>;
type RouteFacts = Readonly<Record<string, unknown>>;

export type SompiApiAudience = "agent" | "operator-recovery";
export type SompiApiLane = "mutation" | "control";
export type SompiHttpMethod = "GET" | "POST";

export interface SompiOperationInputMap {
  readonly createPurchase: PurchaseCreateRequest;
  readonly getPurchase: Readonly<{ purchaseId: string }>;
  readonly recoverPurchase: Readonly<{ purchaseId: string }>;
  readonly getWallet: undefined;
  readonly listWalletActivity: Readonly<{ limit: number }>;
  readonly getWalletTechnical: undefined;
  readonly createTransfer: TransferCreateRequest;
  readonly getTransfer: Readonly<{ transferId: string }>;
  readonly recoverTransfer: Readonly<{ transferId: string }>;
  readonly createPolicyChange: PolicyChangeCreateRequest;
  readonly getPolicyChange: Readonly<{ policyChangeId: string }>;
  readonly recoverPolicyChange: Readonly<{ policyChangeId: string }>;
  readonly createVaultMigration: VaultMigrationCreateRequest;
  readonly getVaultMigration: Readonly<{ vaultMigrationId: string }>;
}

export interface SompiOperationOutputMap {
  readonly createPurchase: PurchaseView;
  readonly getPurchase: PurchaseView;
  readonly recoverPurchase: PurchaseView;
  readonly getWallet: WalletView;
  readonly listWalletActivity: readonly WalletActivityItem[];
  readonly getWalletTechnical: WalletTechnicalView;
  readonly createTransfer: TransferView;
  readonly getTransfer: TransferView;
  readonly recoverTransfer: TransferView;
  readonly createPolicyChange: PolicyChangeView;
  readonly getPolicyChange: PolicyChangeView;
  readonly recoverPolicyChange: PolicyChangeView;
  readonly createVaultMigration: VaultMigrationView;
  readonly getVaultMigration: VaultMigrationView;
}

export type SompiOperationId = keyof SompiOperationInputMap;

export interface SompiOperationParameter {
  readonly name: string;
  readonly in: "path" | "query";
  readonly required: boolean;
  readonly schema: JsonSchema;
}

export interface SompiOperationContract {
  readonly operationId: SompiOperationId;
  readonly applicationMethod: keyof SompiApplication;
  readonly method: SompiHttpMethod;
  readonly pathTemplate: string;
  readonly audiences: readonly SompiApiAudience[];
  readonly lane: SompiApiLane;
  readonly hideFromOtherAudiences: boolean;
  readonly summary: string;
  readonly successDescription: string;
  readonly requestSchemaName?: string;
  readonly requestSchema?: JsonSchema;
  readonly responseSchemaName: string;
  readonly responseSchema: JsonSchema;
  readonly parameters: readonly SompiOperationParameter[];
  readonly errorStatuses: readonly number[];
  matchTarget(target: string): RouteFacts | undefined;
  parseInput(value: unknown): unknown;
  buildPath(input: unknown): string;
  invoke(application: SompiApplication, input: unknown, signal?: AbortSignal): Promise<unknown>;
  assertResponse(value: unknown): unknown;
}

type TypedSompiOperation<K extends SompiOperationId> = Omit<
  SompiOperationContract,
  "operationId" | "parseInput" | "buildPath" | "invoke" | "assertResponse"
> & Readonly<{
  operationId: K;
  parseInput(value: unknown): SompiOperationInputMap[K];
  buildPath(input: SompiOperationInputMap[K]): string;
  invoke(
    application: SompiApplication,
    input: SompiOperationInputMap[K],
    signal?: AbortSignal,
  ): Promise<SompiOperationOutputMap[K]>;
  assertResponse(value: unknown): SompiOperationOutputMap[K];
}>;

export type SompiOperationResolution =
  | Readonly<{
      kind: "operation";
      operation: SompiOperationContract;
      routeFacts: RouteFacts;
    }>
  | Readonly<{ kind: "invalid-target" }>
  | Readonly<{ kind: "method-not-allowed" }>
  | Readonly<{ kind: "not-found" }>;

export interface SompiOperationRequest<K extends SompiOperationId> {
  readonly operation: SompiOperationContract;
  readonly input: SompiOperationInputMap[K];
  readonly method: SompiHttpMethod;
  readonly pathname: string;
  readonly body: unknown;
  assertResponse(value: unknown): SompiOperationOutputMap[K];
}

export class SompiOperationRequestError extends Error {
  constructor(options?: ErrorOptions) {
    super("Sompi operation request does not match its contract", options);
    this.name = "SompiOperationRequestError";
  }
}

const AGENT_ONLY = Object.freeze(["agent"] as const);
const AGENT_AND_RECOVERY = Object.freeze(["agent", "operator-recovery"] as const);
const NO_PARAMETERS = Object.freeze([] as const);
const SOMPI_API_ERROR_STATUSES = Object.freeze([
  400, 401, 403, 404, 405, 409, 410, 413, 429, 500, 503, 504,
] as const);

const PURCHASE_ID_PARAMETER = parameter(
  "purchaseId",
  "path",
  true,
  { type: "string", pattern: "^pur_[A-Za-z0-9_-]{22}$" },
);
const TRANSFER_ID_PARAMETER = parameter(
  "transferId",
  "path",
  true,
  { type: "string", pattern: "^trf_[A-Za-z0-9_-]{22}$" },
);
const POLICY_CHANGE_ID_PARAMETER = parameter(
  "policyChangeId",
  "path",
  true,
  { type: "string", pattern: "^pcg_[A-Za-z0-9_-]{22}$" },
);
const VAULT_MIGRATION_ID_PARAMETER = parameter(
  "vaultMigrationId",
  "path",
  true,
  { type: "string", pattern: "^vmg_[A-Za-z0-9_-]{22}$" },
);
const ACTIVITY_LIMIT_PARAMETER = parameter(
  "limit",
  "query",
  false,
  { type: "integer", minimum: 1, maximum: 100, default: 20 },
);

const PURCHASE_STATUS_PATH = /^\/purchases\/(pur_[A-Za-z0-9_-]{22})$/;
const PURCHASE_RECOVERY_PATH = /^\/purchases\/(pur_[A-Za-z0-9_-]{22})\/recover$/;
const TRANSFER_STATUS_PATH = /^\/transfers\/(trf_[A-Za-z0-9_-]{22})$/;
const TRANSFER_RECOVERY_PATH = /^\/transfers\/(trf_[A-Za-z0-9_-]{22})\/recover$/;
const POLICY_CHANGE_STATUS_PATH = /^\/policy-changes\/(pcg_[A-Za-z0-9_-]{22})$/;
const POLICY_CHANGE_RECOVERY_PATH = /^\/policy-changes\/(pcg_[A-Za-z0-9_-]{22})\/recover$/;
const VAULT_MIGRATION_STATUS_PATH = /^\/vault-migrations\/(vmg_[A-Za-z0-9_-]{22})$/;
const WALLET_ACTIVITY_PATH = /^\/wallet\/activity(?:\?limit=([1-9][0-9]{0,2}))?$/;

export const SOMPI_OPERATIONS: readonly SompiOperationContract[] = Object.freeze([
  defineOperation({
    operationId: "createPurchase",
    applicationMethod: "purchase",
    method: "POST",
    pathTemplate: "/purchases",
    audiences: AGENT_ONLY,
    lane: "mutation",
    hideFromOtherAudiences: true,
    summary: "Create or idempotently resume a Purchase",
    successDescription: "Purchase state",
    requestSchemaName: "PurchaseCreateRequest",
    requestSchema: PURCHASE_CREATE_REQUEST_SCHEMA as unknown as JsonSchema,
    responseSchemaName: "PurchaseView",
    responseSchema: PURCHASE_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: NO_PARAMETERS,
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: exactTarget("/purchases"),
    parseInput: parsePurchaseCreateRequest,
    buildPath: () => "/purchases",
    invoke: (application, input, signal) => application.purchase(input, signal),
    assertResponse: assertPurchaseView,
  }),
  defineOperation({
    operationId: "getPurchase",
    applicationMethod: "status",
    method: "GET",
    pathTemplate: "/purchases/{purchaseId}",
    audiences: AGENT_AND_RECOVERY,
    lane: "control",
    hideFromOtherAudiences: false,
    summary: "Read a durable Purchase without an external side effect",
    successDescription: "Purchase state",
    responseSchemaName: "PurchaseView",
    responseSchema: PURCHASE_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: Object.freeze([PURCHASE_ID_PARAMETER]),
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: capturedTarget(PURCHASE_STATUS_PATH, "purchaseId"),
    parseInput: purchaseIdInput,
    buildPath: ({ purchaseId }) => `/purchases/${purchaseId}`,
    invoke: (application, { purchaseId }, signal) => application.status(purchaseId, signal),
    assertResponse: assertPurchaseView,
  }),
  defineOperation({
    operationId: "recoverPurchase",
    applicationMethod: "recover",
    method: "POST",
    pathTemplate: "/purchases/{purchaseId}/recover",
    audiences: AGENT_AND_RECOVERY,
    lane: "control",
    hideFromOtherAudiences: false,
    summary: "Reconcile a Purchase without blind resubmission",
    successDescription: "Reconciled Purchase state",
    responseSchemaName: "PurchaseView",
    responseSchema: PURCHASE_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: Object.freeze([PURCHASE_ID_PARAMETER]),
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: capturedTarget(PURCHASE_RECOVERY_PATH, "purchaseId"),
    parseInput: purchaseIdInput,
    buildPath: ({ purchaseId }) => `/purchases/${purchaseId}/recover`,
    invoke: (application, { purchaseId }, signal) => application.recover(purchaseId, signal),
    assertResponse: assertPurchaseView,
  }),
  defineOperation({
    operationId: "getWallet",
    applicationMethod: "wallet",
    method: "GET",
    pathTemplate: "/wallet",
    audiences: AGENT_ONLY,
    lane: "control",
    hideFromOtherAudiences: true,
    summary: "Read the receive address, useful balances, deposit status, and spending limits",
    successDescription: "Wallet state",
    responseSchemaName: "WalletView",
    responseSchema: WALLET_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: NO_PARAMETERS,
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: exactTarget("/wallet"),
    parseInput: noInput,
    buildPath: () => "/wallet",
    invoke: (application, _input, signal) => application.wallet(signal),
    assertResponse: assertWalletView,
  }),
  defineOperation({
    operationId: "listWalletActivity",
    applicationMethod: "activity",
    method: "GET",
    pathTemplate: "/wallet/activity",
    audiences: AGENT_ONLY,
    lane: "control",
    hideFromOtherAudiences: true,
    summary: "List recent deposits, securing operations, Purchases, and Transfers",
    successDescription: "Wallet activity",
    responseSchemaName: "WalletActivity",
    responseSchema: WALLET_ACTIVITY_SCHEMA as unknown as JsonSchema,
    parameters: Object.freeze([ACTIVITY_LIMIT_PARAMETER]),
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget(target) {
      const match = WALLET_ACTIVITY_PATH.exec(target);
      if (!match) return undefined;
      return Object.freeze({ limit: match[1] === undefined ? 20 : Number(match[1]) });
    },
    parseInput: activityInput,
    buildPath: ({ limit }) => `/wallet/activity?limit=${limit}`,
    invoke: (application, { limit }, signal) => application.activity(limit, signal),
    assertResponse: assertWalletActivity,
  }),
  defineOperation({
    operationId: "getWalletTechnical",
    applicationMethod: "walletTechnical",
    method: "GET",
    pathTemplate: "/wallet/technical",
    audiences: AGENT_ONLY,
    lane: "control",
    hideFromOtherAudiences: false,
    summary: "Read explicitly requested technical wallet evidence",
    successDescription: "Technical wallet evidence",
    responseSchemaName: "WalletTechnicalView",
    responseSchema: WALLET_TECHNICAL_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: NO_PARAMETERS,
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: exactTarget("/wallet/technical"),
    parseInput: noInput,
    buildPath: () => "/wallet/technical",
    invoke: (application, _input, signal) => application.walletTechnical(signal),
    assertResponse: assertWalletTechnicalView,
  }),
  defineOperation({
    operationId: "createTransfer",
    applicationMethod: "transfer",
    method: "POST",
    pathTemplate: "/transfers",
    audiences: AGENT_ONLY,
    lane: "mutation",
    hideFromOtherAudiences: true,
    summary: "Create or idempotently resume a human-approved direct KAS Transfer",
    successDescription: "Transfer state",
    requestSchemaName: "TransferCreateRequest",
    requestSchema: TRANSFER_CREATE_REQUEST_SCHEMA as unknown as JsonSchema,
    responseSchemaName: "TransferView",
    responseSchema: TRANSFER_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: NO_PARAMETERS,
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: exactTarget("/transfers"),
    parseInput: parseTransferCreateRequest,
    buildPath: () => "/transfers",
    invoke: (application, input, signal) => application.transfer(input, signal),
    assertResponse: assertTransferView,
  }),
  defineOperation({
    operationId: "getTransfer",
    applicationMethod: "transferStatus",
    method: "GET",
    pathTemplate: "/transfers/{transferId}",
    audiences: AGENT_AND_RECOVERY,
    lane: "control",
    hideFromOtherAudiences: false,
    summary: "Read a durable Transfer without an external side effect",
    successDescription: "Transfer state",
    responseSchemaName: "TransferView",
    responseSchema: TRANSFER_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: Object.freeze([TRANSFER_ID_PARAMETER]),
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: capturedTarget(TRANSFER_STATUS_PATH, "transferId"),
    parseInput: transferIdInput,
    buildPath: ({ transferId }) => `/transfers/${transferId}`,
    invoke: (application, { transferId }, signal) => application.transferStatus(transferId, signal),
    assertResponse: assertTransferView,
  }),
  defineOperation({
    operationId: "recoverTransfer",
    applicationMethod: "transferRecover",
    method: "POST",
    pathTemplate: "/transfers/{transferId}/recover",
    audiences: AGENT_AND_RECOVERY,
    lane: "control",
    hideFromOtherAudiences: false,
    summary: "Reconcile a Transfer without replacement authorization or payment",
    successDescription: "Reconciled Transfer state",
    responseSchemaName: "TransferView",
    responseSchema: TRANSFER_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: Object.freeze([TRANSFER_ID_PARAMETER]),
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: capturedTarget(TRANSFER_RECOVERY_PATH, "transferId"),
    parseInput: transferIdInput,
    buildPath: ({ transferId }) => `/transfers/${transferId}/recover`,
    invoke: (application, { transferId }, signal) => application.transferRecover(transferId, signal),
    assertResponse: assertTransferView,
  }),
  defineOperation({
    operationId: "createPolicyChange",
    applicationMethod: "changePolicy",
    method: "POST",
    pathTemplate: "/policy-changes",
    audiences: AGENT_ONLY,
    lane: "mutation",
    hideFromOtherAudiences: true,
    summary: "Propose exact everyday spending limits for owner approval",
    successDescription: "Policy Change state",
    requestSchemaName: "PolicyChangeCreateRequest",
    requestSchema: POLICY_CHANGE_CREATE_REQUEST_SCHEMA as unknown as JsonSchema,
    responseSchemaName: "PolicyChangeView",
    responseSchema: POLICY_CHANGE_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: NO_PARAMETERS,
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: exactTarget("/policy-changes"),
    parseInput: parsePolicyChangeCreateRequest,
    buildPath: () => "/policy-changes",
    invoke: (application, input, signal) => application.changePolicy(input, signal),
    assertResponse: assertPolicyChangeView,
  }),
  defineOperation({
    operationId: "getPolicyChange",
    applicationMethod: "policyChangeStatus",
    method: "GET",
    pathTemplate: "/policy-changes/{policyChangeId}",
    audiences: AGENT_ONLY,
    lane: "control",
    hideFromOtherAudiences: false,
    summary: "Read a spending-limit change",
    successDescription: "Policy Change state",
    responseSchemaName: "PolicyChangeView",
    responseSchema: POLICY_CHANGE_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: Object.freeze([POLICY_CHANGE_ID_PARAMETER]),
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: capturedTarget(POLICY_CHANGE_STATUS_PATH, "policyChangeId"),
    parseInput: policyChangeIdInput,
    buildPath: ({ policyChangeId }) => `/policy-changes/${policyChangeId}`,
    invoke: (application, { policyChangeId }, signal) =>
      application.policyChangeStatus(policyChangeId, signal),
    assertResponse: assertPolicyChangeView,
  }),
  defineOperation({
    operationId: "recoverPolicyChange",
    applicationMethod: "policyChangeRecover",
    method: "POST",
    pathTemplate: "/policy-changes/{policyChangeId}/recover",
    audiences: AGENT_AND_RECOVERY,
    lane: "control",
    hideFromOtherAudiences: false,
    summary: "Resume the same owner-approved limit change",
    successDescription: "Policy Change state",
    responseSchemaName: "PolicyChangeView",
    responseSchema: POLICY_CHANGE_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: Object.freeze([POLICY_CHANGE_ID_PARAMETER]),
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: capturedTarget(POLICY_CHANGE_RECOVERY_PATH, "policyChangeId"),
    parseInput: policyChangeIdInput,
    buildPath: ({ policyChangeId }) => `/policy-changes/${policyChangeId}/recover`,
    invoke: (application, { policyChangeId }, signal) =>
      application.policyChangeRecover(policyChangeId, signal),
    assertResponse: assertPolicyChangeView,
  }),
  defineOperation({
    operationId: "createVaultMigration",
    applicationMethod: "vaultMigration",
    method: "POST",
    pathTemplate: "/vault-migrations",
    audiences: AGENT_ONLY,
    lane: "mutation",
    hideFromOtherAudiences: true,
    summary: "Propose a vault protection change for owner approval",
    successDescription: "Vault Migration state",
    requestSchemaName: "VaultMigrationCreateRequest",
    requestSchema: VAULT_MIGRATION_CREATE_REQUEST_SCHEMA as unknown as JsonSchema,
    responseSchemaName: "VaultMigrationView",
    responseSchema: VAULT_MIGRATION_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: NO_PARAMETERS,
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: exactTarget("/vault-migrations"),
    parseInput: parseVaultMigrationCreateRequest,
    buildPath: () => "/vault-migrations",
    invoke: (application, input, signal) => application.vaultMigration(input, signal),
    assertResponse: assertVaultMigrationView,
  }),
  defineOperation({
    operationId: "getVaultMigration",
    applicationMethod: "vaultMigrationStatus",
    method: "GET",
    pathTemplate: "/vault-migrations/{vaultMigrationId}",
    audiences: AGENT_ONLY,
    lane: "control",
    hideFromOtherAudiences: false,
    summary: "Read a vault protection change",
    successDescription: "Vault Migration state",
    responseSchemaName: "VaultMigrationView",
    responseSchema: VAULT_MIGRATION_VIEW_SCHEMA as unknown as JsonSchema,
    parameters: Object.freeze([VAULT_MIGRATION_ID_PARAMETER]),
    errorStatuses: SOMPI_API_ERROR_STATUSES,
    matchTarget: capturedTarget(VAULT_MIGRATION_STATUS_PATH, "vaultMigrationId"),
    parseInput: vaultMigrationIdInput,
    buildPath: ({ vaultMigrationId }) => `/vault-migrations/${vaultMigrationId}`,
    invoke: (application, { vaultMigrationId }, signal) =>
      application.vaultMigrationStatus(vaultMigrationId, signal),
    assertResponse: assertVaultMigrationView,
  }),
]);

const OPERATIONS_BY_ID = new Map(
  SOMPI_OPERATIONS.map((operation) => [operation.operationId, operation] as const),
);

export function sompiOperation<K extends SompiOperationId>(
  operationId: K,
): SompiOperationContract {
  const operation = OPERATIONS_BY_ID.get(operationId);
  if (!operation) throw new Error(`Unknown Sompi operation ${operationId}`);
  return operation;
}

export function buildSompiOperationRequest<K extends SompiOperationId>(
  operationId: K,
  value: SompiOperationInputMap[K],
): SompiOperationRequest<K> {
  const operation = sompiOperation(operationId);
  const input = operation.parseInput(value) as SompiOperationInputMap[K];
  return Object.freeze({
    operation,
    input,
    method: operation.method,
    pathname: operation.buildPath(input),
    body: operation.requestSchema === undefined ? undefined : input,
    assertResponse: (response: unknown) =>
      operation.assertResponse(response) as SompiOperationOutputMap[K],
  });
}

export function resolveSompiOperation(
  method: string,
  target: string,
  audience: SompiApiAudience,
): SompiOperationResolution {
  if (target.includes("#") || target.includes("%")) {
    return Object.freeze({ kind: "invalid-target" });
  }
  const matches = SOMPI_OPERATIONS.flatMap((operation) => {
    const routeFacts = operation.matchTarget(target);
    return routeFacts === undefined ? [] : [{ operation, routeFacts }];
  });
  if (matches.length === 0) {
    return Object.freeze({ kind: target.includes("?") ? "invalid-target" : "not-found" });
  }
  const methodMatches = matches.filter(({ operation }) => operation.method === method);
  const permitted = methodMatches.find(({ operation }) => operation.audiences.includes(audience));
  if (permitted) {
    return Object.freeze({
      kind: "operation",
      operation: permitted.operation,
      routeFacts: permitted.routeFacts,
    });
  }
  if (
    audience === "operator-recovery" &&
    matches.some(({ operation }) => operation.hideFromOtherAudiences)
  ) {
    return Object.freeze({ kind: "not-found" });
  }
  return Object.freeze({ kind: "method-not-allowed" });
}

export async function invokeResolvedSompiOperation(
  application: SompiApplication,
  resolution: Extract<SompiOperationResolution, { kind: "operation" }>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const rawInput = resolution.operation.requestSchema === undefined
    ? routeInput(resolution.routeFacts)
    : body;
  let input: unknown;
  try {
    input = resolution.operation.parseInput(rawInput);
  } catch (cause) {
    if (cause instanceof SompiApiContractError) {
      throw new SompiOperationRequestError({ cause });
    }
    throw cause;
  }
  return resolution.operation.assertResponse(
    await resolution.operation.invoke(application, input, signal),
  );
}

export function sompiArazzoOperationReference(operationId: SompiOperationId): string {
  return `$sourceDescriptions.sompi.${sompiOperation(operationId).operationId}`;
}

export function sompiOperationRequestSchema(operationId: SompiOperationId): JsonSchema {
  const schema = sompiOperation(operationId).requestSchema;
  if (!schema) throw new Error(`Sompi operation ${operationId} has no request schema`);
  const { $id: _id, ...projection } = schema;
  return Object.freeze(projection);
}

function defineOperation<K extends SompiOperationId>(
  operation: TypedSompiOperation<K>,
): SompiOperationContract {
  return Object.freeze(operation) as unknown as SompiOperationContract;
}

function parameter(
  name: string,
  location: SompiOperationParameter["in"],
  required: boolean,
  schema: JsonSchema,
): SompiOperationParameter {
  return Object.freeze({
    name,
    in: location,
    required,
    schema: Object.freeze(schema),
  });
}

function exactTarget(expected: string): (target: string) => RouteFacts | undefined {
  const empty = Object.freeze({});
  return (target) => target === expected ? empty : undefined;
}

function capturedTarget(
  pattern: RegExp,
  name: string,
): (target: string) => RouteFacts | undefined {
  return (target) => {
    const match = pattern.exec(target);
    return match?.[1] === undefined ? undefined : Object.freeze({ [name]: match[1] });
  };
}

function noInput(value: unknown): undefined {
  if (value !== undefined) throw new SompiApiContractError("This operation does not accept input");
  return undefined;
}

function purchaseIdInput(value: unknown): Readonly<{ purchaseId: string }> {
  const purchaseId = singleString(value, "purchaseId");
  try {
    return Object.freeze({ purchaseId: assertPurchaseId(purchaseId) });
  } catch {
    throw new SompiApiContractError("Purchase ID is invalid");
  }
}

function transferIdInput(value: unknown): Readonly<{ transferId: string }> {
  return Object.freeze({ transferId: assertTransferId(singleString(value, "transferId")) });
}

function policyChangeIdInput(value: unknown): Readonly<{ policyChangeId: string }> {
  return Object.freeze({
    policyChangeId: assertPolicyChangeId(singleString(value, "policyChangeId")),
  });
}

function vaultMigrationIdInput(value: unknown): Readonly<{ vaultMigrationId: string }> {
  return Object.freeze({
    vaultMigrationId: assertVaultMigrationId(singleString(value, "vaultMigrationId")),
  });
}

function activityInput(value: unknown): Readonly<{ limit: number }> {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new SompiApiContractError("Wallet activity request is invalid");
  }
  const limit = value.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    throw new SompiApiContractError("Wallet activity limit must be between 1 and 100");
  }
  return Object.freeze({ limit: limit as number });
}

function singleString(value: unknown, name: string): string {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value[name] !== "string"
  ) {
    throw new SompiApiContractError(`Sompi operation parameter ${name} is invalid`);
  }
  return value[name];
}

function routeInput(facts: RouteFacts): unknown {
  return Object.keys(facts).length === 0 ? undefined : facts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
