import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  agentApiCredentialMatches,
  canonicalAgentApiCredentialBytes,
  canonicalRecoveryApiCredentialBytes,
  generateAgentApiCredential,
  generateRecoveryApiCredential,
  loadAgentApiCredential,
  loadRecoveryApiCredential,
  recoveryApiCredentialMatches,
} from "./credential.js";

test("operator-installed agent credential loads only from a stable owner-only test file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-agent-credential-"));
  const filename = path.join(directory, "agent.json");
  const credential = generateAgentApiCredential();
  const bytes = canonicalAgentApiCredentialBytes(credential);
  try {
    fs.writeFileSync(filename, bytes, { mode: 0o600, flag: "wx" });
    const stat = fs.statSync(filename);
    const loaded = loadAgentApiCredential(filename, {
      expectedOwnerUserId: stat.uid,
      runtimeGroupId: stat.gid,
      allowSameUserForTests: true,
    });
    assert.deepEqual(loaded, credential);
    assert.deepEqual(loadAgentApiCredential(filename, {
      expectedOwnerUserId: stat.uid,
      runtimeGroupId: stat.gid,
      ownerOnlyClientFile: true,
    }), credential);
    assert.equal(agentApiCredentialMatches(loaded, `Bearer ${credential.token}`), true);
    assert.equal(agentApiCredentialMatches(loaded, `Bearer ${"A".repeat(43)}`), false);
    fs.chmodSync(filename, 0o644);
    assert.throws(() => loadAgentApiCredential(filename, {
      expectedOwnerUserId: stat.uid,
      runtimeGroupId: stat.gid,
      allowSameUserForTests: true,
    }), /permissions or identity/);
    assert.throws(() => loadAgentApiCredential(filename, {
      expectedOwnerUserId: stat.uid,
      runtimeGroupId: stat.gid,
      ownerOnlyClientFile: true,
    }), /permissions or identity/);
  } finally {
    bytes.fill(0);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("operator recovery credential is cryptographically and structurally separate from the agent credential", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-recovery-credential-"));
  const filename = path.join(directory, "recovery.json");
  const credential = generateRecoveryApiCredential();
  const bytes = canonicalRecoveryApiCredentialBytes(credential);
  try {
    fs.writeFileSync(filename, bytes, { mode: 0o600, flag: "wx" });
    const stat = fs.statSync(filename);
    const loaded = loadRecoveryApiCredential(filename, {
      expectedOwnerUserId: stat.uid,
      runtimeGroupId: stat.gid,
      allowSameUserForTests: true,
    });
    assert.deepEqual(loaded, credential);
    assert.equal(recoveryApiCredentialMatches(loaded, `Bearer ${credential.token}`), true);
    assert.throws(() => loadAgentApiCredential(filename, {
      expectedOwnerUserId: stat.uid,
      runtimeGroupId: stat.gid,
      allowSameUserForTests: true,
    }), /agent API credential is invalid/);
  } finally {
    bytes.fill(0);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
