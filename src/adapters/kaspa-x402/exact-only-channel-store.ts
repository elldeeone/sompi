import type {
  ChannelLookupScope,
  ChannelStore,
  DirectModeChannel,
} from "@kaspa-x402/client";
import type { Hash32Hex, SompiString } from "@kaspa-x402/core";

const BATCH_DISABLED_MESSAGE =
  "Kaspa-x402 batch-settlement is disabled by the Sompi exact-only profile";

/**
 * Alpha.6 requires a ChannelStore even when the client is configured for
 * `exact` only. Exact payments have no channel state, so reads are empty and
 * every mutation fails closed instead of creating a second durability model.
 */
export class ExactOnlyChannelStore implements ChannelStore {
  async loadChannels(_scope: ChannelLookupScope): Promise<DirectModeChannel[]> {
    return [];
  }

  async listRefundableChannels(_nowDaa?: SompiString): Promise<DirectModeChannel[]> {
    return [];
  }

  async saveChannel(_channel: DirectModeChannel): Promise<void> {
    throw batchDisabled("save channel");
  }

  async retireChannel(_channelId: Hash32Hex, _reason?: string): Promise<void> {
    throw batchDisabled("retire channel");
  }

  async deleteChannel(_channelId: Hash32Hex): Promise<void> {
    throw batchDisabled("delete channel");
  }
}

function batchDisabled(operation: string): Error {
  return new Error(`${BATCH_DISABLED_MESSAGE}; cannot ${operation}`);
}
