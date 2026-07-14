import * as fs from "node:fs";

import {
  AUTHORITY_MAC_KEY_BYTES,
  type AuthorityAuthenticationInput,
} from "./protocol.js";

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export interface AuthorityAuthenticationProvider {
  withAuthentication<T>(
    operation: (authentication: AuthorityAuthenticationInput) => T | Promise<T>
  ): Promise<T>;
}

export class AuthorityKeyProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityKeyProviderError";
  }
}

/**
 * Loads the IPC MAC key for one operation, then wipes the operation-owned copy.
 * The file must be a current-user-owned regular file inaccessible to group and
 * other users. No error includes the filename, key identifier, or key bytes.
 */
export class AuthorityMacKeyFile implements AuthorityAuthenticationProvider {
  constructor(
    private readonly filename: string,
    private readonly keyId: string
  ) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new AuthorityKeyProviderError("authority key configuration is invalid");
    }
  }

  async withAuthentication<T>(
    operation: (authentication: AuthorityAuthenticationInput) => T | Promise<T>
  ): Promise<T> {
    if (typeof operation !== "function") {
      throw new AuthorityKeyProviderError("authority key operation is invalid");
    }
    const keyBytes = this.readKey();
    try {
      return await operation(Object.freeze({ keyId: this.keyId, keyBytes }));
    } finally {
      keyBytes.fill(0);
    }
  }

  private readKey(): Uint8Array {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        this.filename,
        fs.constants.O_RDONLY | noFollowFlag()
      );
      const before = fs.fstatSync(descriptor);
      assertSecureKeyFile(before);
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      assertSecureKeyFile(after);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        bytes.byteLength !== AUTHORITY_MAC_KEY_BYTES
      ) {
        bytes.fill(0);
        throw new AuthorityKeyProviderError("authority key file is invalid");
      }
      const keyCopy = Uint8Array.from(bytes);
      bytes.fill(0);
      return keyCopy;
    } catch (error) {
      if (error instanceof AuthorityKeyProviderError) throw error;
      throw new AuthorityKeyProviderError("authority key is unavailable");
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
}

function assertSecureKeyFile(stat: fs.Stats): void {
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new AuthorityKeyProviderError("authority key file is unsafe");
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}
