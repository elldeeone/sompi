import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  canonicalAgentApiCredentialBytes,
  canonicalRecoveryApiCredentialBytes,
  generateAgentApiCredential,
  generateRecoveryApiCredential,
} from "./credential.js";
import {
  sompiApiConnectionConfigFromEnv,
  sompiApiListenerConfigFromEnv,
  sompiRecoveryApiListenerConfigFromEnv,
} from "./config.js";

test("API environment accepts only a permissioned Unix socket and securely installed credential", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-api-config-"));
  const filename = path.join(directory, "agent.json");
  const socketPath = path.join(directory, "api.sock");
  const bytes = canonicalAgentApiCredentialBytes(generateAgentApiCredential());
  const recoveryFilename = path.join(directory, "recovery.json");
  const recoverySocketPath = path.join(directory, "recovery.sock");
  const recoveryBytes = canonicalRecoveryApiCredentialBytes(generateRecoveryApiCredential());
  try {
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    fs.writeFileSync(recoveryFilename, recoveryBytes, { mode: 0o600 });
    const stat = fs.statSync(filename);
    const env = {
      SOMPI_API_SOCKET: socketPath,
      SOMPI_API_DEADLINE_MS: "90000",
      SOMPI_API_MAX_MUTATION_CONCURRENCY: "4",
      SOMPI_API_MAX_CONTROL_CONCURRENCY: "2",
      SOMPI_AGENT_API_CREDENTIAL: filename,
      SOMPI_OPERATOR_UID: String(stat.uid),
      SOMPI_API_UID: String(stat.uid),
      SOMPI_RUNTIME_GID: String(stat.gid),
      SOMPI_RECOVERY_API_SOCKET: recoverySocketPath,
      SOMPI_RECOVERY_API_CREDENTIAL: recoveryFilename,
      SOMPI_RECOVERY_GID: String(stat.gid),
      SOMPI_RECOVERY_API_MAX_CONCURRENCY: "3",
      SOMPI_RECOVERY_API_MAX_CONNECTIONS: "7",
    };
    const connection = sompiApiConnectionConfigFromEnv(env, { allowSameUserForTests: true });
    assert.equal(connection.socketPath, socketPath);
    assert.equal(connection.expectedServerUserId, stat.uid);
    assert.equal(connection.runtimeGroupId, stat.gid);
    const listener = sompiApiListenerConfigFromEnv(env, { allowSameUserForTests: true });
    assert.equal(listener.maxMutationConcurrency, 4);
    assert.equal(listener.maxControlConcurrency, 2);
    assert.equal(listener.deadlineMs, 90_000);
    const recovery = sompiRecoveryApiListenerConfigFromEnv(env, { allowSameUserForTests: true });
    assert.equal(recovery.socketPath, recoverySocketPath);
    assert.equal(recovery.maxControlConcurrency, 3);
    assert.equal(recovery.maxConnections, 7);
    assert.notEqual(recovery.credential.schema, connection.credential.schema);
    assert.throws(
      () => sompiRecoveryApiListenerConfigFromEnv({ ...env, SOMPI_RECOVERY_API_SOCKET: socketPath }, { allowSameUserForTests: true }),
      /distinct socket path/
    );
    assert.throws(
      () => sompiApiConnectionConfigFromEnv({ ...env, SOMPI_API_SOCKET: "relative.sock" }, { allowSameUserForTests: true }),
      /socket path/
    );
    assert.throws(
      () => sompiApiConnectionConfigFromEnv({ ...env, SOMPI_API_HOST: "127.0.0.1" }, { allowSameUserForTests: true }),
      /removed/
    );
    assert.throws(
      () => sompiApiConnectionConfigFromEnv(env),
      /distinct non-root runtime principal/
    );
  } finally {
    bytes.fill(0);
    recoveryBytes.fill(0);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
