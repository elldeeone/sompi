import { createHash, randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import type {
  ChannelKey,
  ChannelSigner,
  RefundSignRequest,
  VoucherSignRequest,
} from "@kaspa-x402/client";
import type { Hash32Hex, SignatureHex } from "@kaspa-x402/core";

import { SecureLocalStateDirectory } from "../../secure-local-state.js";

const MAX_KEY_BYTES = 512;
const KEY_FILE = /^channel-([a-f0-9]{64})\.json$/;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,160}$/;
const OPERATION_FILE = /^operation-([a-f0-9]{64})\.json$/;

interface PersistedChannelKey {
  readonly version: 1;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly createdAt: string;
}

interface PersistedOperationKey {
  readonly version: 1;
  readonly operationKey: string;
  readonly publicKey: string;
}

/** Owner-only batch signer. Journal/API/MCP callers never receive secret key bytes. */
export class SecureBatchChannelSigner implements ChannelSigner {
  private readonly directory: SecureLocalStateDirectory;

  constructor(
    directory: string,
    private readonly now: () => number = Date.now,
    private readonly generateSecret: () => Uint8Array = () => schnorr.utils.randomSecretKey()
  ) {
    this.directory = new SecureLocalStateDirectory(directory, "batch channel key store");
    readClock(this.now);
  }

  async generateChannelKey(): Promise<ChannelKey> {
    return this.createChannelKey();
  }

  /**
   * Returns one durable client key for an idempotent channel-capitalization
   * operation. A retry after a crash therefore reconstructs the same channel
   * identity instead of funding another escrow.
   */
  async ensureChannelKey(operationKey: string): Promise<ChannelKey> {
    if (!OPERATION_KEY.test(operationKey)) throw new Error("batch channel operation key is invalid");
    const filename = operationFilename(operationKey);
    if (this.directory.fileExists(filename)) {
      const bytes = this.directory.readFile(filename, MAX_KEY_BYTES);
      try {
        const parsed = JSON.parse(bytes.toString("utf8")) as Partial<PersistedOperationKey>;
        if (
          parsed.version !== 1 || parsed.operationKey !== operationKey ||
          typeof parsed.publicKey !== "string" || !/^[a-f0-9]{64}$/.test(parsed.publicKey)
        ) {
          throw new Error("batch channel operation binding is invalid");
        }
        this.readKey(parsed.publicKey);
        return Object.freeze({ publicKey: parsed.publicKey as Hash32Hex });
      } finally {
        bytes.fill(0);
      }
    }

    const key = await this.createChannelKey();
    const binding: PersistedOperationKey = {
      version: 1,
      operationKey,
      publicKey: key.publicKey,
    };
    try {
      this.directory.createFileExclusive(
        filename,
        Buffer.from(`${JSON.stringify(binding)}\n`, "utf8"),
        MAX_KEY_BYTES
      );
      return key;
    } catch (error) {
      // Another process may have durably won the same operation identity.
      if (this.directory.fileExists(filename)) return this.ensureChannelKey(operationKey);
      throw error;
    }
  }

  signDigest(publicKey: string, digest: string): SignatureHex {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("batch transaction digest is invalid");
    const key = this.readKey(publicKey);
    const secret = Buffer.from(key.privateKey, "hex");
    try {
      return Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), secret)).toString("hex") as SignatureHex;
    } finally {
      secret.fill(0);
    }
  }

  private async createChannelKey(): Promise<ChannelKey> {
    const secret = Uint8Array.from(this.generateSecret());
    if (secret.byteLength !== 32) throw new Error("batch channel key generator returned invalid entropy");
    try {
      const privateKey = Buffer.from(secret).toString("hex");
      const publicKey = Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
      const record: PersistedChannelKey = {
        version: 1,
        publicKey,
        privateKey,
        createdAt: new Date(readClock(this.now)).toISOString(),
      };
      this.directory.createFileExclusive(
        keyFilename(publicKey),
        Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
        MAX_KEY_BYTES
      );
      return Object.freeze({ publicKey: publicKey as Hash32Hex });
    } finally {
      secret.fill(0);
    }
  }

  async randomSalt(): Promise<Hash32Hex> {
    return randomBytes(32).toString("hex") as Hash32Hex;
  }

  async randomNonce(): Promise<Hash32Hex> {
    return randomBytes(32).toString("hex") as Hash32Hex;
  }

  async signVoucher(request: VoucherSignRequest): Promise<SignatureHex> {
    if (request.channel.clientPublicKey !== request.channel.config.clientPublicKey) {
      throw new Error("batch channel client identity is inconsistent");
    }
    if (!/^[a-f0-9]{64}$/.test(request.digest)) throw new Error("batch voucher digest is invalid");
    return this.signDigest(request.channel.clientPublicKey, request.digest);
  }

  async signRefund(_request: RefundSignRequest): Promise<SignatureHex> {
    throw new Error("batch refund signing requires a prepared Treasury refund movement");
  }

  private readKey(publicKey: string): PersistedChannelKey {
    const bytes = this.directory.readFile(keyFilename(publicKey), MAX_KEY_BYTES);
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as Partial<PersistedChannelKey>;
      if (
        parsed.version !== 1 || parsed.publicKey !== publicKey ||
        typeof parsed.privateKey !== "string" || !/^[a-f0-9]{64}$/.test(parsed.privateKey) ||
        Buffer.from(schnorr.getPublicKey(Buffer.from(parsed.privateKey, "hex"))).toString("hex") !== publicKey
      ) {
        throw new Error("batch channel key binding is invalid");
      }
      return parsed as PersistedChannelKey;
    } finally {
      bytes.fill(0);
    }
  }
}

function keyFilename(publicKey: string): string {
  const filename = `channel-${publicKey}.json`;
  if (!KEY_FILE.test(filename)) throw new Error("batch channel public key is invalid");
  return filename;
}

function operationFilename(operationKey: string): string {
  const digest = createHash("sha256").update(operationKey, "utf8").digest("hex");
  const filename = `operation-${digest}.json`;
  if (!OPERATION_FILE.test(filename)) throw new Error("batch channel operation filename is invalid");
  return filename;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("batch signer clock is invalid");
  return value;
}
