import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { loadAgentApiCredential } from "../api/credential.js";
import { installAgentApiCredential } from "./agent-credential.js";

test("operator installs one secret credential without returning its token", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-agent-install-"));
  const filename = path.join(directory, "agent.json");
  try {
    const ids = { operatorUserId: process.getuid?.() ?? 0, runtimeGroupId: process.getgid?.() ?? 0 };
    const result = installAgentApiCredential(filename, { ...ids, allowSameUserForTests: true });
    assert.deepEqual(Object.keys(result).sort(), ["credentialId", "filename"]);
    assert.equal(JSON.stringify(result).includes("token"), false);
    const loaded = loadAgentApiCredential(filename, {
      expectedOwnerUserId: ids.operatorUserId,
      runtimeGroupId: ids.runtimeGroupId,
      allowSameUserForTests: true,
    });
    assert.equal(loaded.id, result.credentialId);
    assert.throws(() => installAgentApiCredential(filename, { ...ids, allowSameUserForTests: true }), /already exists/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
