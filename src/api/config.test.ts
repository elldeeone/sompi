import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { canonicalAgentApiCredentialBytes, generateAgentApiCredential } from "./credential.js";
import { purchaseApiConnectionConfigFromEnv, purchaseApiListenerConfigFromEnv } from "./config.js";

test("API environment accepts only loopback and a securely installed credential", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-api-config-"));
  const filename = path.join(directory, "agent.json");
  const bytes = canonicalAgentApiCredentialBytes(generateAgentApiCredential());
  try {
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    const stat = fs.statSync(filename);
    const env = {
      SOMPI_API_HOST: "127.0.0.1",
      SOMPI_API_PORT: "7443",
      SOMPI_API_DEADLINE_MS: "90000",
      SOMPI_API_MAX_CONCURRENCY: "4",
      SOMPI_AGENT_API_CREDENTIAL: filename,
      SOMPI_OPERATOR_UID: String(stat.uid),
      SOMPI_RUNTIME_GID: String(stat.gid),
    };
    const connection = purchaseApiConnectionConfigFromEnv(env, { allowSameUserForTests: true });
    assert.equal(connection.baseUrl, "http://127.0.0.1:7443");
    const listener = purchaseApiListenerConfigFromEnv(env, { allowSameUserForTests: true });
    assert.equal(listener.maxConcurrency, 4);
    assert.equal(listener.deadlineMs, 90_000);
    assert.throws(() => purchaseApiConnectionConfigFromEnv({ ...env, SOMPI_API_HOST: "0.0.0.0" }, { allowSameUserForTests: true }), /loopback/);
  } finally {
    bytes.fill(0);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
