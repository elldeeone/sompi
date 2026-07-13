import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { evidenceDigest } from "./identity.js";
import type { Sha256Digest } from "./types.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DIGEST_PATTERN = /^sha256:([A-Za-z0-9_-]{43})$/;
const TEMP_PREFIX = ".evidence-tmp-";

export interface StoredEvidence {
  digest: Sha256Digest;
  byteLength: number;
  /** Path relative to this EvidenceStore's directory. */
  storageRef: string;
}

export class EvidenceStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EvidenceStoreError";
  }
}

/**
 * Immutable, content-addressed storage for raw Evidence Attachment bytes.
 *
 * The Purchase Journal stores only the returned metadata. Every read validates
 * the file type, permissions, expected length, and digest before returning any
 * bytes to its caller.
 */
export class EvidenceStore {
  private readonly directory: string;
  private readonly directoryIdentity: { dev: bigint; ino: bigint };

  constructor(directory: string) {
    this.directory = path.resolve(directory);
    const existed = pathExists(this.directory);

    try {
      if (!existed) {
        fs.mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });
        fs.chmodSync(this.directory, DIRECTORY_MODE);
      }
      const stat = secureDirectoryStat(this.directory);
      this.directoryIdentity = { dev: BigInt(stat.dev), ino: BigInt(stat.ino) };
    } catch (error) {
      if (error instanceof EvidenceStoreError) throw error;
      throw new EvidenceStoreError("could not initialize secure evidence directory", { cause: error });
    }
  }

  store(bytes: Uint8Array): StoredEvidence {
    this.assertDirectoryUnchanged();
    const content = Buffer.from(bytes);
    const digest = evidenceDigest(content);
    const stored = this.referenceFor(digest, content.byteLength);
    const target = this.pathFor(stored.storageRef);

    if (pathExists(target)) {
      const existing = this.read(digest, content.byteLength);
      if (!existing.equals(content)) {
        throw new EvidenceStoreError("existing evidence bytes do not match their content address");
      }
      return stored;
    }

    const temporary = path.join(
      this.directory,
      `${TEMP_PREFIX}${process.pid}-${randomBytes(16).toString("hex")}`
    );
    let temporaryExists = false;

    try {
      const descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollowFlag(),
        FILE_MODE
      );
      temporaryExists = true;
      try {
        fs.fchmodSync(descriptor, FILE_MODE);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }

      this.assertDirectoryUnchanged();
      if (pathExists(target)) {
        const existing = this.read(digest, content.byteLength);
        if (!existing.equals(content)) {
          throw new EvidenceStoreError("concurrent evidence bytes do not match their content address");
        }
        fs.unlinkSync(temporary);
        temporaryExists = false;
        fsyncDirectory(this.directory);
        return stored;
      }

      fs.renameSync(temporary, target);
      temporaryExists = false;
      fsyncDirectory(this.directory);

      const persisted = this.read(digest, content.byteLength);
      if (!persisted.equals(content)) {
        throw new EvidenceStoreError("persisted evidence bytes changed during atomic storage");
      }
      return stored;
    } catch (error) {
      if (temporaryExists) {
        try {
          fs.unlinkSync(temporary);
          fsyncDirectory(this.directory);
        } catch {
          // Preserve the primary fail-closed error. Stale temporary files are
          // never addressable through the public EvidenceStore interface.
        }
      }
      if (error instanceof EvidenceStoreError) throw error;
      throw new EvidenceStoreError("could not atomically store evidence", { cause: error });
    }
  }

  read(digest: Sha256Digest, expectedByteLength?: number): Buffer {
    this.assertDirectoryUnchanged();
    const storageRef = storageRefForDigest(digest);
    const filename = this.pathFor(storageRef);
    requireExpectedLength(expectedByteLength);

    let descriptor: number | undefined;
    try {
      const before = secureEvidenceStat(filename);
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollowFlag());
      const opened = fs.fstatSync(descriptor, { bigint: true });
      assertSecureEvidenceFile(opened);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new EvidenceStoreError("evidence file changed while it was being opened");
      }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      assertSecureEvidenceFile(after);
      if (after.size !== BigInt(bytes.byteLength)) {
        throw new EvidenceStoreError("evidence file length changed while it was being read");
      }
      if (expectedByteLength !== undefined && bytes.byteLength !== expectedByteLength) {
        throw new EvidenceStoreError("evidence file length does not match the expected length");
      }
      if (evidenceDigest(bytes) !== digest) {
        throw new EvidenceStoreError("evidence file digest verification failed");
      }
      return bytes;
    } catch (error) {
      if (error instanceof EvidenceStoreError) throw error;
      if (isErrno(error, "ENOENT")) {
        throw new EvidenceStoreError("evidence file is missing", { cause: error });
      }
      if (isErrno(error, "ELOOP")) {
        throw new EvidenceStoreError("evidence file must not be a symbolic link", { cause: error });
      }
      throw new EvidenceStoreError("could not securely read evidence", { cause: error });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  verify(digest: Sha256Digest, expectedByteLength?: number): StoredEvidence {
    const bytes = this.read(digest, expectedByteLength);
    return this.referenceFor(digest, bytes.byteLength);
  }

  /** Removes only an unreferenced pre-admission orphan after journal rollback. */
  removeUnreferenced(digest: Sha256Digest): void {
    this.assertDirectoryUnchanged();
    const filename = this.pathFor(storageRefForDigest(digest));
    try {
      const stat = secureEvidenceStat(filename);
      if (evidenceDigest(fs.readFileSync(filename)) !== digest) {
        throw new EvidenceStoreError("orphan evidence failed its content address");
      }
      if (stat.nlink !== 1n) throw new EvidenceStoreError("orphan evidence has unexpected links");
      fs.unlinkSync(filename);
      fsyncDirectory(this.directory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      if (error instanceof EvidenceStoreError) throw error;
      throw new EvidenceStoreError("could not remove an unreferenced evidence orphan", { cause: error });
    }
  }

  private referenceFor(digest: Sha256Digest, byteLength: number): StoredEvidence {
    return {
      digest,
      byteLength,
      storageRef: storageRefForDigest(digest),
    };
  }

  private pathFor(storageRef: string): string {
    const filename = path.join(this.directory, storageRef);
    if (path.dirname(filename) !== this.directory) {
      throw new EvidenceStoreError("invalid evidence storage reference");
    }
    return filename;
  }

  private assertDirectoryUnchanged(): void {
    const stat = secureDirectoryStat(this.directory);
    if (BigInt(stat.dev) !== this.directoryIdentity.dev || BigInt(stat.ino) !== this.directoryIdentity.ino) {
      throw new EvidenceStoreError("evidence directory identity changed after initialization");
    }
  }
}

function storageRefForDigest(digest: Sha256Digest): string {
  const match = DIGEST_PATTERN.exec(digest);
  if (!match) throw new EvidenceStoreError("invalid SHA-256 evidence digest");
  return `sha256-${match[1]}.evidence`;
}

function secureDirectoryStat(directory: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new EvidenceStoreError("evidence directory is missing", { cause: error });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw new EvidenceStoreError("evidence directory must not be a symbolic link");
  if (!stat.isDirectory()) throw new EvidenceStoreError("evidence store path must be a directory");
  if ((stat.mode & 0o777) !== DIRECTORY_MODE) {
    throw new EvidenceStoreError("evidence directory permissions must be 0700");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new EvidenceStoreError("evidence directory must be owned by the current user");
  }
  return stat;
}

function secureEvidenceStat(filename: string): fs.BigIntStats {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(filename, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new EvidenceStoreError("evidence file is missing", { cause: error });
    }
    throw error;
  }
  assertSecureEvidenceFile(stat);
  return stat;
}

function assertSecureEvidenceFile(stat: fs.BigIntStats): void {
  if (stat.isSymbolicLink()) throw new EvidenceStoreError("evidence file must not be a symbolic link");
  if (!stat.isFile()) throw new EvidenceStoreError("evidence path must be a regular file");
  if ((Number(stat.mode) & 0o777) !== FILE_MODE) {
    throw new EvidenceStoreError("evidence file permissions must be 0600");
  }
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
    throw new EvidenceStoreError("evidence file must be owned by the current user");
  }
  if (stat.nlink !== 1n) throw new EvidenceStoreError("evidence file must have exactly one filesystem link");
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | directoryFlag() | noFollowFlag()
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function requireExpectedLength(expectedByteLength: number | undefined): void {
  if (
    expectedByteLength !== undefined &&
    (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0)
  ) {
    throw new EvidenceStoreError("expected evidence length must be a non-negative safe integer");
  }
}

function pathExists(filename: string): boolean {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function noFollowFlag(): number {
  return fs.constants.O_NOFOLLOW ?? 0;
}

function directoryFlag(): number {
  return fs.constants.O_DIRECTORY ?? 0;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
