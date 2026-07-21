import type { AddressCodec } from "@kaspa-x402/client";
import type { ByteHex, NetworkId } from "@kaspa-x402/core";

import {
  Address,
  ScriptPublicKey,
  addressFromScriptPublicKey,
  payToAddressScript,
} from "../../kaspa-wasm.js";

const X402_TESTNET_10: NetworkId = "kaspa:testnet-10";
const SDK_TESTNET_10 = "testnet-10";
const TESTNET_ADDRESS_PREFIX = "kaspatest";
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * Strict alpha.9 AddressCodec for the pinned testnet-10 exact profiles.
 *
 * Kaspa addresses do not encode the testnet suffix. Restricting the x402
 * network to testnet-10 here, and round-tripping every address through the
 * vendored SDK with that network ID, prevents an accidental mainnet/profile
 * widening at this seam.
 */
export class KaspaTestnet10AddressCodec implements AddressCodec {
  scriptPublicKeyForAddress(address: string, network: NetworkId): ByteHex {
    assertTestnet10(network);
    const parsed = parseCanonicalTestnetAddress(address);
    let scriptPublicKey: ScriptPublicKey | undefined;
    try {
      scriptPublicKey = payToAddressScript(parsed);
      const serialized = serializeScriptPublicKey(scriptPublicKey.version, scriptPublicKey.script);
      const roundTrip = addressFromScriptPublicKey(scriptPublicKey, SDK_TESTNET_10);
      if (!roundTrip) {
        throw new Error("Kaspa SDK could not derive an address from its script public key");
      }
      try {
        if (roundTrip.toString() !== address) {
          throw new Error("Kaspa address does not round-trip canonically on testnet-10");
        }
      } finally {
        roundTrip.free();
      }
      return serialized;
    } finally {
      scriptPublicKey?.free();
      parsed.free();
    }
  }

  encodeScriptAddress(input: Parameters<AddressCodec["encodeScriptAddress"]>[0]): string {
    assertTestnet10(input.network);
    const version = input.scriptPublicKey.version;
    const script = input.scriptPublicKey.script;
    const expectedSerialized = serializeScriptPublicKey(version, script);
    if (input.serializedScriptPublicKey.toLowerCase() !== expectedSerialized) {
      throw new Error("serialized script public key does not match the supplied script public key");
    }

    const scriptPublicKey = new ScriptPublicKey(version, script);
    try {
      const address = addressFromScriptPublicKey(scriptPublicKey, SDK_TESTNET_10);
      if (!address) {
        throw new Error("Kaspa SDK could not encode the script address for testnet-10");
      }
      try {
        const encoded = address.toString();
        const parsed = parseCanonicalTestnetAddress(encoded);
        parsed.free();
        return encoded;
      } finally {
        address.free();
      }
    } finally {
      scriptPublicKey.free();
    }
  }
}

/** Serialize the SDK representation expected by Kaspa-x402 alpha.9. */
export function serializeScriptPublicKey(version: number, script: string): ByteHex {
  if (!Number.isInteger(version) || version !== 0) {
    throw new Error("the initial Kaspa-x402 profile requires script public key version 0");
  }
  if (!HEX_BYTES.test(script)) {
    throw new Error("script public key must contain one or more complete hexadecimal bytes");
  }
  return `${version.toString(16).padStart(4, "0")}${script.toLowerCase()}`;
}

function parseCanonicalTestnetAddress(address: string): Address {
  if (typeof address !== "string" || !address.startsWith(`${TESTNET_ADDRESS_PREFIX}:`)) {
    throw new Error("address must use the kaspatest prefix for kaspa:testnet-10");
  }
  if (!Address.validate(address)) {
    throw new Error("address is not a valid Kaspa address");
  }
  const parsed = new Address(address);
  if (parsed.prefix !== TESTNET_ADDRESS_PREFIX || parsed.toString() !== address) {
    parsed.free();
    throw new Error("address is not canonical for kaspa:testnet-10");
  }
  return parsed;
}

function assertTestnet10(network: NetworkId): void {
  if (network !== X402_TESTNET_10) {
    throw new Error(`unsupported Kaspa-x402 network ${network}; only ${X402_TESTNET_10} is enabled`);
  }
}
