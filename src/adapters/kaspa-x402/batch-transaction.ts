import type {
  BatchClaimTxV1Artifact,
  BatchRefundTxV1Artifact,
} from "@kaspa-x402/covenant";

import { ScriptPublicKey, Transaction } from "../../kaspa-wasm.js";

type BatchTransactionArtifact = BatchClaimTxV1Artifact | BatchRefundTxV1Artifact;

/** Rehydrate one public alpha.9 reference artifact through the pinned Kaspa SDK. */
export function sdkBatchTransaction(artifact: BatchTransactionArtifact): Transaction {
  const scripts: ScriptPublicKey[] = [];
  try {
    const inputs = artifact.transaction.inputs.map((input) => {
      const script = sdkScript(input.utxo.scriptPublicKey);
      scripts.push(script);
      return {
        previousOutpoint: {
          transactionId: input.previousOutpoint.txid,
          index: input.previousOutpoint.index,
        },
        signatureScript: input.signatureScript,
        sequence: BigInt(input.sequence),
        sigOpCount: 0,
        computeBudget: input.computeBudget,
        utxo: {
          outpoint: {
            transactionId: input.previousOutpoint.txid,
            index: input.previousOutpoint.index,
          },
          amount: BigInt(input.utxo.amount),
          scriptPublicKey: script,
          blockDaaScore: 0n,
          isCoinbase: false,
        },
      };
    });
    const outputs = artifact.transaction.outputs.map((output) => {
      const script = sdkScript(output.scriptPublicKey);
      scripts.push(script);
      return { value: BigInt(output.amount), scriptPublicKey: script };
    });
    return new Transaction({
      version: 1,
      inputs,
      outputs,
      lockTime: BigInt(artifact.transaction.lockTime),
      subnetworkId: artifact.transaction.subnetworkId,
      gas: BigInt(artifact.transaction.gas),
      payload: artifact.transaction.payload,
      storageMass: BigInt(artifact.transaction.mass),
    } as never);
  } finally {
    for (const script of scripts) script.free();
  }
}

function sdkScript(serialized: string): ScriptPublicKey {
  if (!/^0000(?:[a-f0-9]{2})+$/.test(serialized)) {
    throw new Error("batch transaction script is invalid");
  }
  return new ScriptPublicKey(0, serialized.slice(4));
}
