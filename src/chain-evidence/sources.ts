import type { RpcClient } from "../kaspa-wasm.js";
import { Transaction } from "../kaspa-wasm.js";
import { digest, nonPresent, outputsDigest } from "./module.js";
import type {
  ChainEvidenceRequest,
  ChainSourceEvidence,
  IndependentChainWitness,
  OperatorChainObserver,
} from "./types.js";

const HASH32 = /^[a-f0-9]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface HttpsAcceptedChainWitnessOptions {
  readonly baseUrl: string;
  readonly depthConfirmationDaa: bigint | number | string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => number;
}

/** Independent explorer/history witness. HTTP 404 is the only absence result. */
export class HttpsAcceptedChainWitness implements IndependentChainWitness {
  private readonly baseUrl: string;
  private readonly depth: bigint;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: HttpsAcceptedChainWitnessOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Chain Evidence witness must be an uncredentialed HTTPS base URL");
    }
    this.baseUrl = url.href;
    this.depth = positiveBigInt(options.depthConfirmationDaa, "witness confirmation depth");
    if (typeof options.fetch !== "function") throw new Error("Chain Evidence witness requires an injected fetch boundary");
    this.fetcher = options.fetch;
    this.now = options.now ?? Date.now;
  }

  async observe(request: Readonly<ChainEvidenceRequest>): Promise<ChainSourceEvidence> {
    request.signal.throwIfAborted();
    const transactionResponse = await this.fetcher(
      new URL(`transactions/${request.transactionId}?inputs=true&outputs=true&resolve_previous_outpoints=light`, this.baseUrl),
      { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: request.signal }
    );
    if (transactionResponse.status === 404) {
      drain(transactionResponse);
      return nonPresent("absent", "kaspa-rest-accepted-history-v1", digest({ source: this.baseUrl, transactionId: request.transactionId, httpStatus: 404 }), readTime(this.now()));
    }
    if (!transactionResponse.ok) {
      drain(transactionResponse);
      return nonPresent("unavailable", "kaspa-rest-accepted-history-v1", digest({ source: this.baseUrl, transactionId: request.transactionId, httpStatus: transactionResponse.status }), readTime(this.now()));
    }
    const transaction = await boundedJson(transactionResponse);
    const transactionId = hash(transaction.transaction_id, "witness transaction ID");
    if (transactionId !== request.transactionId || transaction.is_accepted !== true) {
      return nonPresent("unknown", "kaspa-rest-accepted-history-v1", digest({ source: this.baseUrl, transactionId: request.transactionId, result: "not-accepted" }), readTime(this.now()));
    }
    validateWitnessTransaction(transaction, request);
    const blocks = stringArray(transaction.block_hash, "witness transaction block hashes").map((value) => hash(value, "witness transaction block hash"));
    if (blocks.length < 1) throw new Error("witness transaction has no containing block");
    const blockHash = [...blocks].sort()[0];
    const acceptingBlockHash = hash(transaction.accepting_block_hash, "witness accepting block hash");
    const [blockResponse, dagResponse] = await Promise.all([
      this.fetcher(new URL(`blocks/${acceptingBlockHash}`, this.baseUrl), { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: request.signal }),
      this.fetcher(new URL("info/blockdag", this.baseUrl), { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: request.signal }),
    ]);
    if (!blockResponse.ok || !dagResponse.ok) {
      drain(blockResponse); drain(dagResponse);
      return nonPresent("unavailable", "kaspa-rest-accepted-history-v1", digest({ source: this.baseUrl, transactionId: request.transactionId, blockStatus: blockResponse.status, dagStatus: dagResponse.status }), readTime(this.now()));
    }
    const [block, dag] = await Promise.all([boundedJson(blockResponse), boundedJson(dagResponse)]);
    const header = record(block.header, "witness accepting block header");
    const acceptingDaa = uint(header.daaScore, "witness accepting block DAA");
    const virtualDaa = uint(dag.virtualDaaScore, "witness virtual DAA");
    if (virtualDaa < acceptingDaa) return nonPresent("unknown", "kaspa-rest-accepted-history-v1", digest({ source: this.baseUrl, transactionId: request.transactionId, result: "daa-inversion" }), readTime(this.now()));
    const level = virtualDaa - acceptingDaa >= this.depth ? "depth-confirmed" as const : "accepted" as const;
    const expectedDigest = outputsDigest(request);
    return Object.freeze({
      status: "present" as const,
      level,
      view: "historical" as const,
      sourceProfile: "kaspa-rest-accepted-history-v1",
      transactionId,
      blockHash,
      acceptingBlockHash,
      acceptingBlockDaaScore: acceptingDaa.toString(),
      virtualDaaScore: virtualDaa.toString(),
      outputsDigest: expectedDigest,
      detailDigest: digest({ source: this.baseUrl, transactionId, blockHash, acceptingBlockHash, acceptingDaa: acceptingDaa.toString(), virtualDaa: virtualDaa.toString(), outputsDigest: expectedDigest }),
      observedAtMs: readTime(this.now()),
    });
  }
}

export interface WrpcOperatorChainObserverOptions {
  readonly rpc: { client(): Promise<RpcClient> };
  readonly depthConfirmationDaa: bigint | number | string;
  readonly now?: () => number;
}

/** Operator wRPC corroborator. It never turns generic RPC exceptions into absence. */
export class WrpcOperatorChainObserver implements OperatorChainObserver {
  private readonly depth: bigint;
  private readonly now: () => number;
  constructor(private readonly options: WrpcOperatorChainObserverOptions) {
    if (typeof options?.rpc?.client !== "function") throw new Error("operator wRPC provider is required");
    this.depth = positiveBigInt(options.depthConfirmationDaa, "operator confirmation depth");
    this.now = options.now ?? Date.now;
  }

  async observe(request: Readonly<ChainEvidenceRequest>, witness: Readonly<ChainSourceEvidence>): Promise<ChainSourceEvidence> {
    request.signal.throwIfAborted();
    const rpc = await this.options.rpc.client();
    const info = await rpc.getServerInfo();
    if (!info.isSynced || !info.hasUtxoIndex || !["testnet-10", "kaspa:testnet-10"].includes(String(info.networkId))) {
      return nonPresent("unavailable", "kaspa-operator-wrpc-v1", digest({ result: "node-profile-unavailable" }), readTime(this.now()));
    }
    const virtualDaa = BigInt(info.virtualDaaScore);
    if (witness.status === "present" && witness.level !== "provisional") {
      try {
        const chain = await rpc.getVirtualChainFromBlock({
          startHash: witness.blockHash,
          includeAcceptedTransactionIds: true,
          minConfirmationCount: 0,
        });
        const matches = chain.acceptedTransactionIds.filter((entry) =>
          entry.acceptedTransactionIds.some((candidate) => String(candidate).toLowerCase() === request.transactionId)
        );
        if (matches.length !== 1 || String(matches[0].acceptingBlockHash).toLowerCase() !== witness.acceptingBlockHash) {
          return nonPresent("unknown", "kaspa-operator-wrpc-v1", digest({ result: "accepted-history-conflict", transactionId: request.transactionId }), readTime(this.now()));
        }
        const block = await rpc.getBlock({ hash: witness.acceptingBlockHash, includeTransactions: false });
        const header = block.block.header;
        const headerHash = String(header.hash).toLowerCase();
        const acceptingDaa = BigInt(header.daaScore);
        if (headerHash !== witness.acceptingBlockHash || acceptingDaa.toString() !== witness.acceptingBlockDaaScore || virtualDaa < acceptingDaa) {
          return nonPresent("unknown", "kaspa-operator-wrpc-v1", digest({ result: "accepting-block-conflict", transactionId: request.transactionId }), readTime(this.now()));
        }
        const level = virtualDaa - acceptingDaa >= this.depth ? "depth-confirmed" as const : "accepted" as const;
        return Object.freeze({
          status: "present" as const, level, view: "historical" as const,
          sourceProfile: "kaspa-operator-wrpc-v1", transactionId: request.transactionId,
          blockHash: witness.blockHash, acceptingBlockHash: witness.acceptingBlockHash,
          acceptingBlockDaaScore: acceptingDaa.toString(), virtualDaaScore: virtualDaa.toString(),
          outputsDigest: outputsDigest(request),
          detailDigest: digest({ source: "operator-wrpc", transactionId: request.transactionId, blockHash: witness.blockHash, acceptingBlockHash: witness.acceptingBlockHash, acceptingDaa: acceptingDaa.toString(), virtualDaa: virtualDaa.toString() }),
          observedAtMs: readTime(this.now()),
        });
      } catch {
        return nonPresent("unavailable", "kaspa-operator-wrpc-v1", digest({ result: "accepted-history-unavailable", transactionId: request.transactionId }), readTime(this.now()));
      }
    }

    // Before absence is possible, independently check the operator node's
    // current UTXO view. A lagging witness must not erase a live exact output.
    try {
      const current = await rpc.getUtxosByAddresses([...request.watchedAddresses]);
      const currentView = inspectCurrentOutputs(current.entries as unknown[], request);
      if (currentView === "present") {
        return Object.freeze({
          status: "present" as const, level: "provisional" as const, view: "current" as const,
          sourceProfile: "kaspa-operator-wrpc-v1", transactionId: request.transactionId,
          outputsDigest: outputsDigest(request),
          detailDigest: digest({ source: "operator-wrpc-utxo", transactionId: request.transactionId, outputsDigest: outputsDigest(request) }),
          observedAtMs: readTime(this.now()),
        });
      }
      if (currentView === "partial") {
        return nonPresent("unknown", "kaspa-operator-wrpc-v1", digest({ result: "partial-current-output-view", transactionId: request.transactionId }), readTime(this.now()));
      }

      // A bounded address query gives a complete pool view for the
      // transaction's known source/destination addresses without interpreting
      // exception text.
      const pool = await rpc.getMempoolEntriesByAddresses({
        addresses: [...request.watchedAddresses],
        includeOrphanPool: true,
        filterTransactionPool: false,
      });
      const matches = pool.entries.filter((entry) => deriveTransactionId(entry.transaction) === request.transactionId);
      if (matches.length > 1) return nonPresent("unknown", "kaspa-operator-wrpc-v1", digest({ result: "duplicate-mempool-identity", transactionId: request.transactionId }), readTime(this.now()));
      if (matches.length === 1) {
        validateWrpcTransaction(matches[0].transaction, request);
        return Object.freeze({
          status: "present" as const, level: "provisional" as const, view: "current" as const,
          sourceProfile: "kaspa-operator-wrpc-v1", transactionId: request.transactionId,
          outputsDigest: outputsDigest(request),
          detailDigest: digest({ source: "operator-wrpc-mempool", transactionId: request.transactionId, outputsDigest: outputsDigest(request) }),
          observedAtMs: readTime(this.now()),
        });
      }
      return nonPresent("absent", "kaspa-operator-wrpc-v1", digest({ source: "operator-wrpc-address-pool", result: "absent", transactionId: request.transactionId, watchedAddresses: request.watchedAddresses }), readTime(this.now()));
    } catch {
      return nonPresent("unavailable", "kaspa-operator-wrpc-v1", digest({ result: "mempool-address-view-unavailable", transactionId: request.transactionId }), readTime(this.now()));
    }
  }
}

function validateWitnessTransaction(transaction: Record<string, unknown>, request: Readonly<ChainEvidenceRequest>): void {
  const outputs = array(transaction.outputs, "witness outputs").map((value) => record(value, "witness output"));
  for (const expected of request.expectedOutputs) {
    const matches = outputs.filter((output) => Number(output.index) === expected.index);
    if (
      matches.length !== 1 ||
      uint(matches[0].amount, "witness output amount").toString() !== expected.amountAtomic ||
      !witnessScriptMatches(matches[0].script_public_key, expected.scriptPublicKey)
    ) {
      throw new Error("witness transaction output differs from the prepared transaction");
    }
    if (expected.covenantId !== undefined && String(matches[0].covenant_id ?? "").toLowerCase() !== expected.covenantId) {
      throw new Error("witness covenant identity differs from the prepared transaction");
    }
  }
  if (request.expectedInputs) {
    const inputs = array(transaction.inputs, "witness inputs").map((value) => record(value, "witness input"));
    for (const expected of request.expectedInputs) {
      if (!inputs.some((input) => String(input.previous_outpoint_hash).toLowerCase() === expected.transactionId && Number(input.previous_outpoint_index) === expected.index)) {
        throw new Error("witness transaction input differs from the prepared transaction");
      }
    }
  }
}

function validateWrpcTransaction(transaction: unknown, request: Readonly<ChainEvidenceRequest>): void {
  const value = record(transaction, "wRPC transaction");
  const outputs = array(value.outputs, "wRPC outputs").map((entry) => record(entry, "wRPC output"));
  for (const expected of request.expectedOutputs) {
    const output = outputs[expected.index];
    const script = record(output?.scriptPublicKey, "wRPC output script");
    const serialized = `${Number(script.version).toString(16).padStart(4, "0")}${String(script.script).toLowerCase()}`;
    if (!output || BigInt(output.value as string | number | bigint).toString() !== expected.amountAtomic || serialized !== expected.scriptPublicKey) {
      throw new Error("wRPC mempool output differs from the prepared transaction");
    }
  }
}

function deriveTransactionId(value: unknown): string {
  let transaction: Transaction | undefined;
  try {
    transaction = new Transaction(value as never);
    return hash(String(transaction.finalize()).toLowerCase(), "wRPC mempool transaction ID");
  } finally {
    transaction?.free();
  }
}

function inspectCurrentOutputs(
  entries: readonly unknown[],
  request: Readonly<ChainEvidenceRequest>
): "present" | "absent" | "partial" {
  let present = 0;
  for (const expected of request.expectedOutputs) {
    const candidates = entries
      .map((value) => record(value, "wRPC UTXO entry"))
      .filter((entry) => {
        const nested = isRecord(entry.entry) ? entry.entry : entry;
        const outpoint = isRecord(entry.outpoint) ? entry.outpoint : record(nested.outpoint, "wRPC UTXO outpoint");
        return String(outpoint.transactionId ?? "").toLowerCase() === request.transactionId && Number(outpoint.index) === expected.index;
      });
    if (candidates.length > 1) return "partial";
    if (candidates.length === 0) continue;
    const entry = candidates[0];
    const nested = isRecord(entry.entry) ? entry.entry : entry;
    const script = record(entry.scriptPublicKey ?? nested.scriptPublicKey, "wRPC UTXO script");
    const serialized = `${Number(script.version).toString(16).padStart(4, "0")}${String(script.script).toLowerCase()}`;
    const covenantId = String(entry.covenantId ?? nested.covenantId ?? "").toLowerCase();
    if (
      BigInt(entry.amount ?? nested.amount).toString() !== expected.amountAtomic ||
      serialized !== expected.scriptPublicKey ||
      (expected.covenantId !== undefined && covenantId !== expected.covenantId)
    ) {
      return "partial";
    }
    present += 1;
  }
  if (present === request.expectedOutputs.length) return "present";
  return present === 0 ? "absent" : "partial";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function witnessScriptMatches(value: unknown, expected: string): boolean {
  const actual = String(value).toLowerCase();
  const canonical = expected.toLowerCase();
  if (!/^(?:[a-f0-9]{2})+$/.test(actual) || !/^(?:[a-f0-9]{2})+$/.test(canonical)) {
    return false;
  }
  // KREST exposes the version-0 script body, while Sompi and Kaspa-x402 bind
  // the canonical serialized ScriptPublicKey including its 16-bit version.
  return actual === canonical || (canonical.startsWith("0000") && actual === canonical.slice(4));
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new Error("Chain Evidence response is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Chain Evidence response size is invalid");
  return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "Chain Evidence response");
}

function drain(response: Response): void { void response.body?.cancel().catch(() => undefined); }
function record(value: unknown, label: string): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`); return value as Record<string, any>; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} is invalid`); return value; }
function stringArray(value: unknown, label: string): string[] { const values = array(value, label); if (values.some((entry) => typeof entry !== "string")) throw new Error(`${label} is invalid`); return values as string[]; }
function hash(value: unknown, label: string): string { if (typeof value !== "string" || !HASH32.test(value.toLowerCase())) throw new Error(`${label} is invalid`); return value.toLowerCase(); }
function uint(value: unknown, label: string): bigint { const text = String(value); if (!UINT.test(text)) throw new Error(`${label} is invalid`); return BigInt(text); }
function positiveBigInt(value: bigint | number | string, label: string): bigint { const parsed = BigInt(value); if (parsed <= 0n) throw new Error(`${label} is invalid`); return parsed; }
function readTime(value: number): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Chain Evidence clock is invalid"); return value; }
