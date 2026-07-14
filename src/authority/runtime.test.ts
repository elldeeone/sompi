import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { loadAp2TrustStore, loadAuthoritySigningIdentity } from "../adapters/ap2/signing-key-file.js";
import { AuthorityMacKeyFile } from "./key-provider.js";
import { AUTHORITY_MAC_KEY_BYTES } from "./protocol.js";
import {
  authorityClientRuntimePaths,
  authorityRuntimePaths,
  initializeAuthorityRuntime,
} from "./runtime.js";

test("authority init creates only owner-readable credentials and public trust material", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-authority-runtime-"));
  const paths = authorityRuntimePaths({ rootDirectory: path.join(root, "authority") });
  try {
    const entry = await initializeAuthorityRuntime(paths, {
      issuer: "urn:sompi:authority:test-runtime",
      kid: "authority-key-1",
    });
    assert.equal(entry.role, "authority");
    for (const filename of [
      paths.serverMacKey,
      paths.clientMacKey,
      paths.privateJwk,
      paths.publicTrustEntry,
      paths.serverTrust,
      paths.clientTrust,
    ]) {
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    }
    for (const directory of [
      paths.privateDirectory,
      paths.clientDirectory,
      paths.runtimeDirectory,
    ]) {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    }
    assert.notEqual(paths.privateDirectory, paths.clientDirectory);
    assert.notEqual(paths.privateDirectory, paths.runtimeDirectory);
    const clientPaths = authorityClientRuntimePaths({
      clientDirectory: paths.clientDirectory,
      runtimeDirectory: paths.runtimeDirectory,
      socketPath: paths.socket,
    });
    assert.deepEqual(Object.keys(clientPaths).sort(), [
      "directory",
      "macKey",
      "socket",
      "trust",
    ]);
    assert.equal(JSON.stringify(clientPaths).includes("private"), false);
    assert.deepEqual(
      fs.readFileSync(paths.serverMacKey),
      fs.readFileSync(paths.clientMacKey),
    );
    const signer = loadAuthoritySigningIdentity(paths.privateJwk, entry.issuer, entry.kid);
    assert.equal(signer.privateJwk.x, entry.publicJwk.x);
    assert(loadAp2TrustStore(paths.serverTrust).resolve("authority", entry.issuer, entry.kid));
    assert(loadAp2TrustStore(paths.clientTrust).resolve("authority", entry.issuer, entry.kid));
    const mac = new AuthorityMacKeyFile(paths.clientMacKey, "authority-ipc-key-1");
    await mac.withAuthentication(async (authentication) => {
      assert.equal(authentication.keyBytes.byteLength, AUTHORITY_MAC_KEY_BYTES);
    });
    await assert.rejects(
      initializeAuthorityRuntime(paths, { issuer: entry.issuer, kid: entry.kid }),
      /refuses to overwrite/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
