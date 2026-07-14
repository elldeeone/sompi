import type {
  PreparedVaultSpend,
  PreparedVaultDeposit,
  VaultManager,
} from "../vault.js";
import type {
  KaspaWallet,
  PreparedWalletSend,
} from "../wallet.js";
import { WalletPreparationError } from "../wallet.js";
import { VaultPreparationError } from "../vault.js";
import type {
  PreparedTreasuryOperationMaterial,
  TreasuryOperationKind,
  TreasuryOperationRecord,
  TreasuryOperationObservationStatus,
  TreasuryOperationValidationInput,
} from "./operation-journal.js";
import { Address } from "../kaspa-wasm.js";
import { meets, type ChainEvidenceModule } from "../chain-evidence/module.js";
import type { ChainEvidenceRecord, ExpectedChainOutput, FinalityFloor } from "../chain-evidence/types.js";

const PROFILE = "urn:sompi:treasury-operation:prepared:1" as const;
const OBSERVATION_PROFILE = "urn:sompi:treasury-operation:observation:1" as const;
const HASH32 = /^[a-f0-9]{64}$/;

export interface TreasuryOperationProbe {
  readonly status: TreasuryOperationObservationStatus;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type TreasuryPreparationErrorCode =
  | "invalid_destination"
  | "invalid_transaction_shape"
  | "insufficient_funds"
  | "not_funded"
  | "invalid_runtime_state"
  | "transient_unavailable";

/** Typed adapter classification. Unknown errors remain fenced for recovery. */
export class TreasuryPreparationError extends Error {
  readonly phase: "validation" | "preparation";
  readonly effect: "none" | "possible";
  readonly code: TreasuryPreparationErrorCode;

  constructor(
    code: TreasuryPreparationErrorCode,
    phase: "validation" | "preparation",
    message: string,
    effect: "none" | "possible" = "none",
  ) {
    super(message);
    this.name = "TreasuryPreparationError";
    this.code = code;
    this.phase = phase;
    this.effect = effect;
  }
}

/** Real seam: wallet and consensus-vault adapters both implement it. */
export interface TreasuryOperationAdapter {
  readonly kind: TreasuryOperationKind;
  /** Must be side-effect-free and run before durable intent admission. */
  validateRequest?(input: TreasuryOperationValidationInput): void;
  prepare(
    intent: TreasuryOperationRecord,
    authorize: (destination: string, amountAtomic: bigint) => void
  ): Promise<PreparedTreasuryOperationMaterial>;
  submit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<{ readonly transactionId: string }>;
  observe(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<TreasuryOperationProbe>;
  commit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array,
    observedDetail: Readonly<Record<string, unknown>>
  ): Promise<void>;
}

interface WalletEnvelope {
  readonly version: 1;
  readonly profile: typeof PROFILE;
  readonly kind: "wallet_send";
  readonly binding: OperationBinding;
  readonly observationStartHash: string;
  readonly prepared: {
    readonly transaction: string;
    readonly transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
    readonly transactionId: string;
    readonly sourceAddress: string;
    readonly destination: string;
    readonly destinationOutpoint: { readonly txid: string; readonly index: number };
    readonly amountAtomic: string;
    readonly feeAtomic: string;
    readonly sourceInputs: readonly {
      readonly txid: string;
      readonly index: number;
      readonly amountAtomic: string;
    }[];
  };
}

interface VaultEnvelope {
  readonly version: 1;
  readonly profile: typeof PROFILE;
  readonly kind: "vault_send";
  readonly binding: OperationBinding;
  readonly observationStartHash: string;
  readonly prepared: {
    readonly transaction: string;
    readonly transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
    readonly transactionId: string;
    readonly destination: string;
    readonly destinationOutpoint: { readonly txid: string; readonly index: 0 };
    readonly amountAtomic: string;
    readonly feeAtomic: string;
    readonly continuationOutpoint: { readonly txid: string; readonly index: 1 };
    readonly continuationAddress: string;
    readonly continuationAmountAtomic: string;
    readonly covenantId: string;
    readonly baseConfigDigest: string;
    readonly configUpdate: PreparedVaultSpend["configUpdate"];
  };
}

interface OperationBinding {
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly destination: string;
  readonly requestedAmountAtomic: string | "max";
  readonly keepFloatAtomic?: string;
  readonly feeCeilingAtomic: string;
  readonly network: "kaspa:testnet-10";
}

interface VaultDepositEnvelope {
  readonly version: 1;
  readonly profile: typeof PROFILE;
  readonly kind: "vault_deposit";
  readonly binding: OperationBinding;
  readonly observationStartHash: string;
  readonly prepared: {
    readonly transaction: string;
    readonly transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
    readonly transactionId: string;
    readonly depositKind: "initial" | "topup";
    readonly depositedAtomic: string;
    readonly feeAtomic: string;
    readonly vaultAddress: string;
    readonly vaultOutpoint: { readonly txid: string; readonly index: 0 };
    readonly vaultAmountAtomic: string;
    readonly covenantId: string;
    readonly baseConfigDigest: string;
    readonly sourceInputs: readonly {
      readonly address: string;
      readonly txid: string;
      readonly index: number;
      readonly amountAtomic: string;
    }[];
    readonly configUpdate: PreparedVaultDeposit["configUpdate"];
  };
}

export class WalletTreasuryOperationAdapter implements TreasuryOperationAdapter {
  readonly kind = "wallet_send" as const;

  constructor(
    private readonly wallet: KaspaWallet,
    private readonly chainEvidence: ChainEvidenceModule,
    private readonly finalityFloor: FinalityFloor
  ) {
    if (!wallet || wallet.networkId !== "testnet-10") {
      throw new Error("wallet Treasury operation adapter requires testnet-10");
    }
  }

  validateRequest(input: TreasuryOperationValidationInput): void {
    validateDestination(input.destination);
    if (input.requestedAmountAtomic === "max") {
      throw new TreasuryPreparationError(
        "invalid_transaction_shape",
        "validation",
        "wallet Treasury operation requires an exact amount",
      );
    }
  }

  async prepare(
    intent: TreasuryOperationRecord,
    authorize: (destination: string, amountAtomic: bigint) => void
  ): Promise<PreparedTreasuryOperationMaterial> {
    requireIntent(intent, this.kind);
    if (intent.requestedAmountAtomic === "max") {
      throw new TreasuryPreparationError(
        "invalid_transaction_shape",
        "preparation",
        "wallet Treasury operation requires an exact amount",
      );
    }
    const amount = BigInt(intent.requestedAmountAtomic);
    authorize(intent.destination, amount);
    let observationStartHash: string;
    try {
      observationStartHash = await chainStartHash(this.wallet);
    } catch (error) {
      throw classifyWalletPreparationError(error);
    }
    let prepared: PreparedWalletSend;
    try {
      prepared = await this.wallet.prepareSend(
        intent.destination,
        amount,
        BigInt(intent.feeCeilingAtomic)
      );
    } catch (error) {
      throw classifyWalletPreparationError(error);
    }
    const envelope = walletEnvelope(intent, observationStartHash, prepared);
    const bytes = encode(envelope);
    decodeWallet(bytes, intent);
    return Object.freeze({
      bytes,
      transactionId: prepared.transactionId,
      amountAtomic: prepared.amountSompi.toString(),
      feeAtomic: prepared.feeSompi.toString(),
    });
  }

  async submit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<{ readonly transactionId: string }> {
    const envelope = decodeWallet(preparedBytes, intent);
    return this.wallet.submitPreparedSend(walletPrepared(envelope));
  }

  async observe(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<TreasuryOperationProbe> {
    const envelope = decodeWallet(preparedBytes, intent);
    const observation = await observeEnvelopeChainEvidence(this.chainEvidence, intent, envelope, this.finalityFloor);
    return Object.freeze({
      status: observation.status,
      detail: Object.freeze({
        profile: OBSERVATION_PROFILE,
        kind: this.kind,
        status: observation.status,
        operationKey: intent.operationKey,
        transactionId: envelope.prepared.transactionId,
        destinationOutpoint: `${envelope.prepared.transactionId}:${envelope.prepared.destinationOutpoint.index}`,
        amountAtomic: envelope.prepared.amountAtomic,
        ...(observation.evidence
          ? {
              chainEvidenceDigest: observation.evidence.detailDigest,
              chainEvidenceLevel: observation.evidence.level,
              ...(observation.evidence.acceptingBlockDaaScore === undefined
                ? {}
                : { observedAtDaa: observation.evidence.acceptingBlockDaaScore }),
            }
          : {}),
      }),
    });
  }

  async commit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array,
    observedDetail: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const envelope = decodeWallet(preparedBytes, intent);
    requireObservedDetail(observedDetail, intent, envelope.prepared.transactionId, false);
    // A regular-wallet send has no mutable local chain state to advance. The
    // durable observed fact itself is the idempotent commit.
  }
}

export class VaultSendTreasuryOperationAdapter implements TreasuryOperationAdapter {
  readonly kind = "vault_send" as const;

  constructor(
    private readonly vault: VaultManager,
    private readonly wallet: KaspaWallet,
    private readonly chainEvidence: ChainEvidenceModule,
    private readonly finalityFloor: FinalityFloor
  ) {
    if (!vault || !wallet || wallet.networkId !== "testnet-10") {
      throw new Error("vault Treasury operation adapter requires testnet-10");
    }
  }

  validateRequest(input: TreasuryOperationValidationInput): void {
    validateDestination(input.destination);
    if (input.requestedAmountAtomic === "max") {
      throw new TreasuryPreparationError(
        "invalid_transaction_shape",
        "validation",
        "vault Treasury operation requires an exact amount",
      );
    }
  }

  async prepare(
    intent: TreasuryOperationRecord,
    authorize: (destination: string, amountAtomic: bigint) => void
  ): Promise<PreparedTreasuryOperationMaterial> {
    requireIntent(intent, this.kind);
    const requested = intent.requestedAmountAtomic === "max"
      ? "max" as const
      : BigInt(intent.requestedAmountAtomic);
    let observationStartHash: string;
    try {
      observationStartHash = await chainStartHash(this.wallet);
    } catch (error) {
      throw classifyWalletPreparationError(error);
    }
    let prepared: PreparedVaultSpend;
    try {
      prepared = await this.vault.prepareSend(
        this.wallet,
        intent.destination,
        requested,
        (resolved) => authorize(intent.destination, resolved),
        BigInt(intent.feeCeilingAtomic)
      );
    } catch (error) {
      throw classifyVaultPreparationError(error);
    }
    const envelope = vaultEnvelope(intent, observationStartHash, prepared);
    const bytes = encode(envelope);
    decodeVault(bytes, intent);
    return Object.freeze({
      bytes,
      transactionId: prepared.transactionId,
      amountAtomic: prepared.amountSompi.toString(),
      feeAtomic: prepared.feeSompi.toString(),
    });
  }

  async submit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<{ readonly transactionId: string }> {
    const envelope = decodeVault(preparedBytes, intent);
    return this.vault.submitPreparedSend(this.wallet, vaultPrepared(envelope));
  }

  async observe(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<TreasuryOperationProbe> {
    const envelope = decodeVault(preparedBytes, intent);
    const observation = await observeEnvelopeChainEvidence(this.chainEvidence, intent, envelope, this.finalityFloor);
    return Object.freeze({
      status: observation.status,
      detail: Object.freeze({
        profile: OBSERVATION_PROFILE,
        kind: this.kind,
        status: observation.status,
        operationKey: intent.operationKey,
        transactionId: envelope.prepared.transactionId,
        destinationOutpoint: `${envelope.prepared.transactionId}:0`,
        continuationOutpoint: `${envelope.prepared.transactionId}:1`,
        amountAtomic: envelope.prepared.amountAtomic,
        continuationAmountAtomic: envelope.prepared.continuationAmountAtomic,
        ...(observation.evidence ? { chainEvidenceDigest: observation.evidence.detailDigest, chainEvidenceLevel: observation.evidence.level, observedAtDaa: observation.evidence.acceptingBlockDaaScore } : {}),
      }),
    });
  }

  async commit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array,
    observedDetail: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const envelope = decodeVault(preparedBytes, intent);
    requireObservedDetail(observedDetail, intent, envelope.prepared.transactionId);
    const prepared = vaultPrepared(envelope);
    this.vault.commitObservedSend(prepared, {
      transactionId: prepared.transactionId,
      destinationOutpoint: prepared.destinationOutpoint,
      continuationOutpoint: prepared.continuationOutpoint,
      amountSompi: prepared.amountSompi,
      continuationAmountSompi: prepared.continuationAmountSompi,
      observedAtDaa: BigInt(observedDetail.observedAtDaa as string),
      chainEvidenceDigest: observedDetail.chainEvidenceDigest as string,
      chainEvidenceLevel: observedDetail.chainEvidenceLevel as
        | "accepted"
        | "depth-confirmed"
        | "consensus-final",
    });
  }
}

export class VaultDepositTreasuryOperationAdapter implements TreasuryOperationAdapter {
  readonly kind = "vault_deposit" as const;

  constructor(
    private readonly vault: VaultManager,
    private readonly wallet: KaspaWallet,
    private readonly chainEvidence: ChainEvidenceModule,
    private readonly finalityFloor: FinalityFloor
  ) {
    if (!vault || !wallet || wallet.networkId !== "testnet-10") {
      throw new Error("vault deposit Treasury operation adapter requires testnet-10");
    }
  }

  validateRequest(input: TreasuryOperationValidationInput): void {
    validateDestination(input.destination);
  }

  async prepare(
    intent: TreasuryOperationRecord,
    _authorize: (destination: string, amountAtomic: bigint) => void
  ): Promise<PreparedTreasuryOperationMaterial> {
    requireIntent(intent, this.kind);
    let config;
    try {
      config = this.vault.config();
    } catch (error) {
      throw classifyVaultPreparationError(error);
    }
    if (!this.vault.configured || config.address !== intent.destination) {
      throw new TreasuryPreparationError(
        "invalid_runtime_state",
        "preparation",
        "vault deposit is not bound to the configured vault",
      );
    }
    const amount = intent.requestedAmountAtomic === "max"
      ? "max" as const
      : BigInt(intent.requestedAmountAtomic);
    const keepFloat = BigInt(intent.keepFloatAtomic ?? "0");
    if (amount !== "max" && keepFloat !== 0n) {
      throw new TreasuryPreparationError(
        "invalid_runtime_state",
        "preparation",
        "keep-float applies only to a maximum vault deposit",
      );
    }
    let observationStartHash: string;
    try {
      observationStartHash = await chainStartHash(this.wallet);
    } catch (error) {
      throw classifyWalletPreparationError(error);
    }
    let prepared: PreparedVaultDeposit;
    try {
      prepared = await this.vault.prepareDeposit(
        this.wallet,
        amount,
        keepFloat,
        BigInt(intent.feeCeilingAtomic)
      );
    } catch (error) {
      throw classifyVaultPreparationError(error);
    }
    const envelope = vaultDepositEnvelope(intent, observationStartHash, prepared);
    const bytes = encode(envelope);
    decodeVaultDeposit(bytes, intent);
    return Object.freeze({
      bytes,
      transactionId: prepared.transactionId,
      amountAtomic: prepared.depositedSompi.toString(),
      feeAtomic: prepared.feeSompi.toString(),
    });
  }

  async submit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<{ readonly transactionId: string }> {
    const envelope = decodeVaultDeposit(preparedBytes, intent);
    return this.vault.submitPreparedDeposit(this.wallet, vaultPreparedDeposit(envelope));
  }

  async observe(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<TreasuryOperationProbe> {
    const envelope = decodeVaultDeposit(preparedBytes, intent);
    const observation = await observeEnvelopeChainEvidence(this.chainEvidence, intent, envelope, this.finalityFloor);
    return Object.freeze({
      status: observation.status,
      detail: Object.freeze({
        profile: OBSERVATION_PROFILE,
        kind: this.kind,
        status: observation.status,
        operationKey: intent.operationKey,
        transactionId: envelope.prepared.transactionId,
        vaultOutpoint: `${envelope.prepared.transactionId}:0`,
        depositedAtomic: envelope.prepared.depositedAtomic,
        vaultAmountAtomic: envelope.prepared.vaultAmountAtomic,
        covenantId: envelope.prepared.covenantId,
        ...(observation.evidence ? { chainEvidenceDigest: observation.evidence.detailDigest, chainEvidenceLevel: observation.evidence.level, observedAtDaa: observation.evidence.acceptingBlockDaaScore } : {}),
      }),
    });
  }

  async commit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array,
    observedDetail: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const envelope = decodeVaultDeposit(preparedBytes, intent);
    requireObservedDetail(observedDetail, intent, envelope.prepared.transactionId);
    const prepared = vaultPreparedDeposit(envelope);
    this.vault.commitObservedDeposit(prepared, {
      transactionId: prepared.transactionId,
      vaultOutpoint: prepared.vaultOutpoint,
      vaultAmountSompi: prepared.vaultAmountSompi,
      covenantId: prepared.covenantId,
      observedAtDaa: BigInt(observedDetail.observedAtDaa as string),
      chainEvidenceDigest: observedDetail.chainEvidenceDigest as string,
      chainEvidenceLevel: observedDetail.chainEvidenceLevel as
        | "accepted"
        | "depth-confirmed"
        | "consensus-final",
    });
  }
}

type EvidenceEnvelope = WalletEnvelope | VaultEnvelope | VaultDepositEnvelope;

function validateDestination(destination: string): void {
  let address: Address | undefined;
  try {
    address = new Address(destination);
    if (address.toString() !== destination) {
      throw new TreasuryPreparationError(
        "invalid_destination",
        "validation",
        "Treasury destination is not a canonical testnet-10 address",
      );
    }
  } catch (error) {
    if (error instanceof TreasuryPreparationError) throw error;
    throw new TreasuryPreparationError(
      "invalid_destination",
      "validation",
      "Treasury destination is not a valid testnet-10 address",
    );
  } finally {
    address?.free();
  }
}

async function observeEnvelopeChainEvidence(
  module: ChainEvidenceModule,
  intent: TreasuryOperationRecord,
  envelope: EvidenceEnvelope,
  floor: FinalityFloor
): Promise<{ readonly status: TreasuryOperationObservationStatus; readonly evidence?: ChainEvidenceRecord }> {
  const expectedOutputs = envelopeExpectedOutputs(envelope);
  const evidence = await module.observe({
    operationId: `treasury:${intent.operationKey}`,
    operation: envelope.kind === "wallet_send" ? "direct-treasury" : "vault",
    network: "kaspa:testnet-10",
    transactionId: envelope.prepared.transactionId,
    expectedOutputs,
    expectedInputs: envelopeExpectedInputs(envelope),
    watchedAddresses: envelopeWatchedAddresses(envelope),
    mechanism: envelope.kind === "wallet_send" ? "ordinary" : "native-covenant",
    protocolFinality: "accepted",
    operatorFloor: floor,
    signal: new AbortController().signal,
  });
  if (evidence.status === "present" && evidence.level && meets(evidence.level, floor)) {
    return Object.freeze({ status: "observed" as const, evidence });
  }
  if (evidence.status === "absent") return Object.freeze({ status: "not_submitted" as const, evidence });
  return Object.freeze({ status: "pending" as const, evidence });
}

function envelopeExpectedOutputs(envelope: EvidenceEnvelope): readonly ExpectedChainOutput[] {
  const scripts = transactionOutputScripts(envelope.prepared.transaction);
  if (envelope.kind === "wallet_send") return Object.freeze([Object.freeze({
    index: envelope.prepared.destinationOutpoint.index,
    amountAtomic: envelope.prepared.amountAtomic,
    scriptPublicKey: scripts[envelope.prepared.destinationOutpoint.index],
    address: envelope.prepared.destination,
  })]);
  if (envelope.kind === "vault_send") return Object.freeze([
    Object.freeze({ index: 0, amountAtomic: envelope.prepared.amountAtomic, scriptPublicKey: scripts[0], address: envelope.prepared.destination }),
    Object.freeze({ index: 1, amountAtomic: envelope.prepared.continuationAmountAtomic, scriptPublicKey: scripts[1], address: envelope.prepared.continuationAddress, covenantId: envelope.prepared.covenantId }),
  ]);
  return Object.freeze([Object.freeze({
    index: 0,
    amountAtomic: envelope.prepared.vaultAmountAtomic,
    scriptPublicKey: scripts[0],
    address: envelope.prepared.vaultAddress,
    covenantId: envelope.prepared.covenantId,
  })]);
}

function envelopeExpectedInputs(envelope: EvidenceEnvelope): readonly { transactionId: string; index: number }[] {
  if (envelope.kind === "wallet_send") return envelope.prepared.sourceInputs.map((input) => Object.freeze({ transactionId: input.txid, index: input.index }));
  if (envelope.kind === "vault_deposit") return envelope.prepared.sourceInputs.map((input) => Object.freeze({ transactionId: input.txid, index: input.index }));
  const document = parsedTransaction(envelope.prepared.transaction);
  return requireArray(document.inputs, "vault send inputs").map((value) => {
    const input = requireRecord(value, "vault send input");
    const previous = requireRecord(input.previousOutpoint, "vault send previous outpoint");
    return Object.freeze({ transactionId: String(previous.transactionId).toLowerCase(), index: Number(previous.index) });
  });
}

function envelopeWatchedAddresses(envelope: EvidenceEnvelope): readonly string[] {
  if (envelope.kind === "wallet_send") return Object.freeze([envelope.prepared.sourceAddress, envelope.prepared.destination]);
  if (envelope.kind === "vault_send") return Object.freeze([envelope.prepared.destination, envelope.prepared.continuationAddress]);
  return Object.freeze([...new Set([...envelope.prepared.sourceInputs.map((input) => input.address), envelope.prepared.vaultAddress])]);
}

function transactionOutputScripts(transaction: string): readonly string[] {
  const document = parsedTransaction(transaction);
  return requireArray(document.outputs, "prepared transaction outputs").map((value) => {
    const output = requireRecord(value, "prepared transaction output");
    if (typeof output.scriptPublicKey === "string" && /^0000[a-f0-9]+$/.test(output.scriptPublicKey)) {
      return output.scriptPublicKey;
    }
    const script = requireRecord(output.scriptPublicKey, "prepared output script");
    const version = Number(script.version);
    if (!Number.isSafeInteger(version) || version < 0 || version > 0xffff || !/^[a-f0-9]+$/.test(String(script.script))) {
      throw new Error("prepared output script is invalid");
    }
    return `${version.toString(16).padStart(4, "0")}${String(script.script).toLowerCase()}`;
  });
}

function parsedTransaction(transaction: string): Record<string, unknown> {
  try { return requireRecord(JSON.parse(transaction), "prepared transaction"); }
  catch (cause) { throw new Error("prepared transaction JSON is invalid", { cause }); }
}

function requireRecord(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, any>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

async function chainStartHash(wallet: KaspaWallet): Promise<string> {
  let info: any;
  try {
    const rpc = await wallet.client();
    info = await rpc.getBlockDagInfo();
  } catch (error) {
    throw new WalletPreparationError("rpc_unavailable", "Kaspa observation data is unavailable", { cause: error });
  }
  const sink = String(info.sink).toLowerCase();
  if (!HASH32.test(sink)) {
    throw new WalletPreparationError("invalid_transaction_shape", "Kaspa observation data is invalid");
  }
  return sink;
}

function classifyWalletPreparationError(error: unknown): TreasuryPreparationError {
  if (error instanceof TreasuryPreparationError) return error;
  if (error instanceof WalletPreparationError) {
    const code = error.code === "insufficient_funds"
      ? "insufficient_funds"
      : error.code === "invalid_transaction_shape" || error.code === "invalid_input" || error.code === "fee_exceeds_ceiling"
        ? "invalid_transaction_shape"
        : "transient_unavailable";
    return new TreasuryPreparationError(code, "preparation", "wallet preparation failed", "none");
  }
  return new TreasuryPreparationError("transient_unavailable", "preparation", "wallet preparation is unavailable", "none");
}

function classifyVaultPreparationError(error: unknown): TreasuryPreparationError {
  if (error instanceof TreasuryPreparationError) return error;
  if (error instanceof WalletPreparationError) return classifyWalletPreparationError(error);
  if (error instanceof VaultPreparationError) {
    const code = error.code === "not_funded"
      ? "not_funded"
      : error.code === "insufficient_funds"
        ? "insufficient_funds"
        : error.code === "invalid_transaction_shape" || error.code === "invalid_input" || error.code === "fee_exceeds_ceiling" || error.code === "invalid_runtime_state"
          ? "invalid_runtime_state"
          : "transient_unavailable";
    return new TreasuryPreparationError(code, "preparation", "vault preparation failed", "none");
  }
  // Unknown adapter failures are deliberately not guessed safe. The Treasury
  // module fences them for reconciliation because a plain exception does not
  // prove that no signed material or external effect exists.
  throw error;
}

function walletEnvelope(
  intent: TreasuryOperationRecord,
  observationStartHash: string,
  prepared: PreparedWalletSend
): WalletEnvelope {
  return Object.freeze({
    version: 1 as const,
    profile: PROFILE,
    kind: "wallet_send" as const,
    binding: binding(intent),
    observationStartHash,
    prepared: Object.freeze({
      transaction: prepared.transaction,
      transactionEncoding: prepared.transactionEncoding,
      transactionId: prepared.transactionId,
      sourceAddress: prepared.sourceAddress,
      destination: prepared.destination,
      destinationOutpoint: Object.freeze({ ...prepared.destinationOutpoint }),
      amountAtomic: prepared.amountSompi.toString(),
      feeAtomic: prepared.feeSompi.toString(),
      sourceInputs: Object.freeze(prepared.sourceInputs.map((input) => Object.freeze({
        txid: input.txid,
        index: input.index,
        amountAtomic: input.amountSompi.toString(),
      }))),
    }),
  });
}

function vaultEnvelope(
  intent: TreasuryOperationRecord,
  observationStartHash: string,
  prepared: PreparedVaultSpend
): VaultEnvelope {
  return Object.freeze({
    version: 1 as const,
    profile: PROFILE,
    kind: "vault_send" as const,
    binding: binding(intent),
    observationStartHash,
    prepared: Object.freeze({
      transaction: prepared.transaction,
      transactionEncoding: prepared.transactionEncoding,
      transactionId: prepared.transactionId,
      destination: prepared.destination,
      destinationOutpoint: Object.freeze({ ...prepared.destinationOutpoint }),
      amountAtomic: prepared.amountSompi.toString(),
      feeAtomic: prepared.feeSompi.toString(),
      continuationOutpoint: Object.freeze({ ...prepared.continuationOutpoint }),
      continuationAddress: prepared.continuationAddress,
      continuationAmountAtomic: prepared.continuationAmountSompi.toString(),
      covenantId: prepared.covenantId,
      baseConfigDigest: prepared.baseConfigDigest,
      configUpdate: Object.freeze({
        ...prepared.configUpdate,
        currentOutpoint: Object.freeze({ ...prepared.configUpdate.currentOutpoint }),
      }),
    }),
  });
}

function vaultDepositEnvelope(
  intent: TreasuryOperationRecord,
  observationStartHash: string,
  prepared: PreparedVaultDeposit
): VaultDepositEnvelope {
  return Object.freeze({
    version: 1 as const,
    profile: PROFILE,
    kind: "vault_deposit" as const,
    binding: binding(intent),
    observationStartHash,
    prepared: Object.freeze({
      transaction: prepared.transaction,
      transactionEncoding: prepared.transactionEncoding,
      transactionId: prepared.transactionId,
      depositKind: prepared.depositKind,
      depositedAtomic: prepared.depositedSompi.toString(),
      feeAtomic: prepared.feeSompi.toString(),
      vaultAddress: prepared.vaultAddress,
      vaultOutpoint: Object.freeze({ ...prepared.vaultOutpoint }),
      vaultAmountAtomic: prepared.vaultAmountSompi.toString(),
      covenantId: prepared.covenantId,
      baseConfigDigest: prepared.baseConfigDigest,
      sourceInputs: Object.freeze(prepared.sourceInputs.map((input) => Object.freeze({
        address: input.address,
        txid: input.txid,
        index: input.index,
        amountAtomic: input.amountSompi.toString(),
      }))),
      configUpdate: Object.freeze({
        ...prepared.configUpdate,
        currentOutpoint: Object.freeze({ ...prepared.configUpdate.currentOutpoint }),
      }),
    }),
  });
}

function binding(intent: TreasuryOperationRecord): OperationBinding {
  return Object.freeze({
    operationKey: intent.operationKey,
    requestDigest: intent.requestDigest,
    destination: intent.destination,
    requestedAmountAtomic: intent.requestedAmountAtomic,
    ...(intent.keepFloatAtomic === undefined ? {} : { keepFloatAtomic: intent.keepFloatAtomic }),
    feeCeilingAtomic: intent.feeCeilingAtomic,
    network: "kaspa:testnet-10" as const,
  });
}

function vaultPreparedDeposit(envelope: VaultDepositEnvelope): PreparedVaultDeposit {
  return Object.freeze({
    transaction: envelope.prepared.transaction,
    transactionEncoding: envelope.prepared.transactionEncoding,
    transactionId: envelope.prepared.transactionId,
    depositKind: envelope.prepared.depositKind,
    depositedSompi: BigInt(envelope.prepared.depositedAtomic),
    feeSompi: BigInt(envelope.prepared.feeAtomic),
    vaultAddress: envelope.prepared.vaultAddress,
    vaultOutpoint: Object.freeze({ ...envelope.prepared.vaultOutpoint }),
    vaultAmountSompi: BigInt(envelope.prepared.vaultAmountAtomic),
    covenantId: envelope.prepared.covenantId,
    baseConfigDigest: envelope.prepared.baseConfigDigest,
    sourceInputs: Object.freeze(envelope.prepared.sourceInputs.map((input) => Object.freeze({
      address: input.address,
      txid: input.txid,
      index: input.index,
      amountSompi: BigInt(input.amountAtomic),
    }))),
    configUpdate: Object.freeze({
      ...envelope.prepared.configUpdate,
      currentOutpoint: Object.freeze({ ...envelope.prepared.configUpdate.currentOutpoint }),
    }),
  });
}

function walletPrepared(envelope: WalletEnvelope): PreparedWalletSend {
  return Object.freeze({
    transaction: envelope.prepared.transaction,
    transactionEncoding: envelope.prepared.transactionEncoding,
    transactionId: envelope.prepared.transactionId,
    sourceAddress: envelope.prepared.sourceAddress,
    destination: envelope.prepared.destination,
    destinationOutpoint: Object.freeze({ ...envelope.prepared.destinationOutpoint }),
    amountSompi: BigInt(envelope.prepared.amountAtomic),
    feeSompi: BigInt(envelope.prepared.feeAtomic),
    sourceInputs: Object.freeze(envelope.prepared.sourceInputs.map((input) => Object.freeze({
      txid: input.txid,
      index: input.index,
      amountSompi: BigInt(input.amountAtomic),
    }))),
  });
}

function vaultPrepared(envelope: VaultEnvelope): PreparedVaultSpend {
  return Object.freeze({
    transaction: envelope.prepared.transaction,
    transactionEncoding: envelope.prepared.transactionEncoding,
    transactionId: envelope.prepared.transactionId,
    destination: envelope.prepared.destination,
    destinationOutpoint: Object.freeze({ ...envelope.prepared.destinationOutpoint }),
    amountSompi: BigInt(envelope.prepared.amountAtomic),
    feeSompi: BigInt(envelope.prepared.feeAtomic),
    continuationOutpoint: Object.freeze({ ...envelope.prepared.continuationOutpoint }),
    continuationAddress: envelope.prepared.continuationAddress,
    continuationAmountSompi: BigInt(envelope.prepared.continuationAmountAtomic),
    covenantId: envelope.prepared.covenantId,
    baseConfigDigest: envelope.prepared.baseConfigDigest,
    configUpdate: Object.freeze({
      ...envelope.prepared.configUpdate,
      currentOutpoint: Object.freeze({ ...envelope.prepared.configUpdate.currentOutpoint }),
    }),
  });
}

function decodeWallet(bytes: Uint8Array, intent: TreasuryOperationRecord): WalletEnvelope {
  const parsed = decode(bytes) as WalletEnvelope;
  if (parsed.kind !== "wallet_send") throw new Error("Prepared wallet operation kind changed");
  const canonical = walletEnvelope(intent, parsed.observationStartHash, walletPrepared(parsed));
  assertEnvelope(canonical, bytes, intent, parsed.observationStartHash);
  return canonical;
}

function decodeVault(bytes: Uint8Array, intent: TreasuryOperationRecord): VaultEnvelope {
  const parsed = decode(bytes) as VaultEnvelope;
  if (parsed.kind !== "vault_send") throw new Error("Prepared vault operation kind changed");
  const canonical = vaultEnvelope(intent, parsed.observationStartHash, vaultPrepared(parsed));
  assertEnvelope(canonical, bytes, intent, parsed.observationStartHash);
  return canonical;
}

function decodeVaultDeposit(
  bytes: Uint8Array,
  intent: TreasuryOperationRecord
): VaultDepositEnvelope {
  const parsed = decode(bytes) as VaultDepositEnvelope;
  if (parsed.kind !== "vault_deposit") {
    throw new Error("Prepared vault deposit operation kind changed");
  }
  const canonical = vaultDepositEnvelope(
    intent,
    parsed.observationStartHash,
    vaultPreparedDeposit(parsed)
  );
  if (
    canonical.version !== 1 ||
    canonical.profile !== PROFILE ||
    canonical.binding.operationKey !== intent.operationKey ||
    canonical.binding.requestDigest !== intent.requestDigest ||
    canonical.binding.destination !== intent.destination ||
    canonical.binding.requestedAmountAtomic !== intent.requestedAmountAtomic ||
    canonical.binding.keepFloatAtomic !== intent.keepFloatAtomic ||
    canonical.binding.feeCeilingAtomic !== intent.feeCeilingAtomic ||
    canonical.binding.network !== "kaspa:testnet-10" ||
    !HASH32.test(canonical.observationStartHash) ||
    !HASH32.test(canonical.prepared.transactionId) ||
    encode(canonical).toString() !== Buffer.from(bytes).toString()
  ) {
    throw new Error("Prepared vault deposit artifact changed its immutable binding");
  }
  atomic(canonical.prepared.depositedAtomic, true);
  atomic(canonical.prepared.feeAtomic, false);
  atomic(canonical.prepared.vaultAmountAtomic, true);
  if (
    intent.requestedAmountAtomic !== "max" &&
    canonical.prepared.depositedAtomic !== intent.requestedAmountAtomic
  ) {
    throw new Error("Prepared vault deposit changed the requested principal");
  }
  return canonical;
}

function assertEnvelope(
  envelope: WalletEnvelope | VaultEnvelope,
  bytes: Uint8Array,
  intent: TreasuryOperationRecord,
  observationStartHash: string
): void {
  requireIntent(intent, envelope.kind);
  if (
    envelope.version !== 1 ||
    envelope.profile !== PROFILE ||
    envelope.binding.operationKey !== intent.operationKey ||
    envelope.binding.requestDigest !== intent.requestDigest ||
    envelope.binding.destination !== intent.destination ||
    envelope.binding.requestedAmountAtomic !== intent.requestedAmountAtomic ||
    envelope.binding.keepFloatAtomic !== intent.keepFloatAtomic ||
    envelope.binding.feeCeilingAtomic !== intent.feeCeilingAtomic ||
    envelope.binding.network !== "kaspa:testnet-10" ||
    !HASH32.test(observationStartHash) ||
    !HASH32.test(envelope.prepared.transactionId) ||
    envelope.prepared.destination !== intent.destination ||
    encode(envelope).toString() !== Buffer.from(bytes).toString()
  ) {
    throw new Error("Prepared Treasury operation artifact changed its immutable binding");
  }
  atomic(envelope.prepared.amountAtomic, true);
  atomic(envelope.prepared.feeAtomic, false);
  if (
    intent.requestedAmountAtomic !== "max" &&
    envelope.prepared.amountAtomic !== intent.requestedAmountAtomic
  ) {
    throw new Error("Prepared Treasury operation changed the requested amount");
  }
}

function requireIntent(intent: TreasuryOperationRecord, kind: TreasuryOperationKind): void {
  if (!intent || intent.kind !== kind || intent.state === "failed_terminal") {
    throw new Error("Treasury operation intent is invalid for this adapter");
  }
}

function requireObservedDetail(
  detail: Readonly<Record<string, unknown>>,
  intent: TreasuryOperationRecord,
  transactionId: string,
  requireObservedAtDaa = true,
): void {
  if (
    detail.profile !== OBSERVATION_PROFILE ||
    detail.kind !== intent.kind ||
    detail.status !== "observed" ||
    detail.operationKey !== intent.operationKey ||
    detail.transactionId !== transactionId ||
    (requireObservedAtDaa && (
      typeof detail.observedAtDaa !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(detail.observedAtDaa)
    )) ||
    typeof detail.chainEvidenceDigest !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(detail.chainEvidenceDigest) ||
    !["accepted", "depth-confirmed", "consensus-final"].includes(
      detail.chainEvidenceLevel as string
    )
  ) {
    throw new Error("Durable Treasury observation changed its operation binding");
  }
}

function encode(value: WalletEnvelope | VaultEnvelope | VaultDepositEnvelope): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > 2_000_000) {
    throw new Error("Prepared Treasury operation artifact is empty or oversized");
  }
  return bytes;
}

function decode(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 2_000_000) {
    throw new Error("Prepared Treasury operation artifact is empty or oversized");
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("Prepared Treasury operation artifact is not JSON");
  }
}

function atomic(value: string, positive: boolean): void {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    (positive && value === "0") ||
    BigInt(value) > (1n << 64n) - 1n
  ) {
    throw new Error("Prepared Treasury operation atomic amount is invalid");
  }
}
