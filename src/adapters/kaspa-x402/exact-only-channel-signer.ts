import type {
  ChannelKey,
  ChannelSigner,
  RefundSignRequest,
  VoucherSignRequest,
} from "@kaspa-x402/client";
import type { Hash32Hex, SignatureHex } from "@kaspa-x402/core";

const BATCH_DISABLED_MESSAGE =
  "Kaspa-x402 batch-settlement signing is disabled by the Sompi exact-only profile";

/**
 * Exact mode never needs channel keys, salts, vouchers, or refund signatures.
 * Keeping this adapter deliberately inert prevents unused batch credentials
 * from being generated or accidentally persisted by the agent-facing process.
 */
export class ExactOnlyChannelSigner implements ChannelSigner {
  async generateChannelKey(): Promise<ChannelKey> {
    throw batchDisabled("generate a channel key");
  }

  async randomSalt(): Promise<Hash32Hex> {
    throw batchDisabled("generate a channel salt");
  }

  async randomNonce(): Promise<Hash32Hex> {
    throw batchDisabled("generate a channel nonce");
  }

  async signVoucher(_request: VoucherSignRequest): Promise<SignatureHex> {
    throw batchDisabled("sign a voucher");
  }

  async signRefund(_request: RefundSignRequest): Promise<SignatureHex> {
    throw batchDisabled("sign a channel refund");
  }
}

function batchDisabled(operation: string): Error {
  return new Error(`${BATCH_DISABLED_MESSAGE}; cannot ${operation}`);
}
