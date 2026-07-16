import { createRequire } from "node:module";

type KaspaWasmModule = typeof import("../vendor/kaspa-wasm/kaspa.js");

// The pinned vendored SDK is CommonJS. Keep that compatibility boundary here
// so every runtime and adapter above it remains native NodeNext ESM.
const require = createRequire(import.meta.url);
const kaspa = require("../vendor/kaspa-wasm/kaspa.js") as KaspaWasmModule;

export const Address = kaspa.Address;
export type Address = import("../vendor/kaspa-wasm/kaspa.js").Address;
export const ScriptPublicKey = kaspa.ScriptPublicKey;
export type ScriptPublicKey = import("../vendor/kaspa-wasm/kaspa.js").ScriptPublicKey;
export const CovenantBinding = kaspa.CovenantBinding;
export type CovenantBinding = import("../vendor/kaspa-wasm/kaspa.js").CovenantBinding;
export const Hash = kaspa.Hash;
export type Hash = import("../vendor/kaspa-wasm/kaspa.js").Hash;
export const Keypair = kaspa.Keypair;
export type Keypair = import("../vendor/kaspa-wasm/kaspa.js").Keypair;
export const PrivateKey = kaspa.PrivateKey;
export type PrivateKey = import("../vendor/kaspa-wasm/kaspa.js").PrivateKey;
export const Resolver = kaspa.Resolver;
export type Resolver = import("../vendor/kaspa-wasm/kaspa.js").Resolver;
export const RpcClient = kaspa.RpcClient;
export type RpcClient = import("../vendor/kaspa-wasm/kaspa.js").RpcClient;
export const Transaction = kaspa.Transaction;
export type Transaction = import("../vendor/kaspa-wasm/kaspa.js").Transaction;
export const XOnlyPublicKey = kaspa.XOnlyPublicKey;
export type XOnlyPublicKey = import("../vendor/kaspa-wasm/kaspa.js").XOnlyPublicKey;

export const SighashType = kaspa.SighashType;
export const addressFromScriptPublicKey = kaspa.addressFromScriptPublicKey;
export const calculateTransactionMass = kaspa.calculateTransactionMass;
export const calculateTransactionFee = kaspa.calculateTransactionFee;
export const createInputSignature = kaspa.createInputSignature;
export const createTransactions = kaspa.createTransactions;
export const initConsolePanicHook = kaspa.initConsolePanicHook;
export const kaspaToSompi = kaspa.kaspaToSompi;
export const payToAddressScript = kaspa.payToAddressScript;
export const payToScriptHashScript = kaspa.payToScriptHashScript;
export const payToScriptHashSignatureScript = kaspa.payToScriptHashSignatureScript;
export const sompiToKaspaString = kaspa.sompiToKaspaString;
