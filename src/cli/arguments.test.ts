import * as assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITY_USAGE,
  CliArgumentError,
  MCP_USAGE,
  OPERATOR_USAGE,
  parseAuthorityArguments,
  parseMcpArguments,
  parseOperatorArguments,
} from "./arguments.js";

test("MCP CLI accepts only its closed command surface", () => {
  assert.deepEqual(parseMcpArguments([]), { kind: "start" });
  assert.deepEqual(parseMcpArguments(["start"]), { kind: "start" });
  assert.deepEqual(parseMcpArguments(["--help"]), { kind: "help" });
  assert.deepEqual(parseMcpArguments(["help"]), { kind: "help" });
  assert.deepEqual(parseMcpArguments(["gen-wallet-key"]), {
    kind: "generate-wallet-key",
    network: "testnet-10",
  });
  assert.deepEqual(parseMcpArguments(["gen-wallet-key", "testnet-10"]), {
    kind: "generate-wallet-key",
    network: "testnet-10",
  });
  assert.deepEqual(parseMcpArguments(["gen-wallet-key"], "testnet-10"), {
    kind: "generate-wallet-key",
    network: "testnet-10",
  });
  for (const args of [
    ["unknown"],
    ["start", "extra"],
    ["--help", "extra"],
    ["gen-owner-key"],
    ["gen-owner-key", "extra"],
    ["gen-wallet-key", "mainnet"],
    ["gen-wallet-key", "testnet-10", "extra"],
  ]) {
    assert.throws(() => parseMcpArguments(args), CliArgumentError);
  }
  assert.match(MCP_USAGE, /^usage: sompi-mcp/);
});

test("operator CLI exposes only preview, provision, install, status, and offline owner-key", () => {
  assert.deepEqual(parseOperatorArguments(["preview", "spec.json"]), { kind: "preview", spec: "spec.json" });
  assert.deepEqual(parseOperatorArguments(["provision", "spec.json", "candidate"]), { kind: "provision", spec: "spec.json", bundle: "candidate" });
  assert.deepEqual(parseOperatorArguments(["install", "candidate", "manifest.json", "sha256:x", "0", "1000", "1000"]), {
    kind: "install", bundle: "candidate", manifest: "manifest.json", digest: "sha256:x", operatorUid: 0, runtimeUid: 1000, runtimeGid: 1000,
  });
  assert.deepEqual(parseOperatorArguments(["status", "manifest.json", "0", "1000"]), { kind: "status", manifest: "manifest.json", operatorUid: 0, runtimeGid: 1000 });
  assert.deepEqual(parseOperatorArguments(["owner-key"]), { kind: "owner-key" });
  for (const args of [[], ["install"], ["status", "x", "-1", "1"], ["owner-key", "extra"], ["start"]]) {
    assert.throws(() => parseOperatorArguments(args), CliArgumentError);
  }
  assert.match(OPERATOR_USAGE, /^usage: sompi-operator/);
});

test("authority CLI accepts only start, init, and help", () => {
  assert.deepEqual(parseAuthorityArguments([]), { kind: "start" });
  assert.deepEqual(parseAuthorityArguments(["start"]), { kind: "start" });
  assert.deepEqual(parseAuthorityArguments(["init"]), { kind: "init" });
  assert.deepEqual(parseAuthorityArguments(["--help"]), { kind: "help" });
  assert.deepEqual(parseAuthorityArguments(["help"]), { kind: "help" });
  for (const args of [
    ["unknown"],
    ["start", "extra"],
    ["init", "extra"],
    ["--help", "extra"],
  ]) {
    assert.throws(() => parseAuthorityArguments(args), CliArgumentError);
  }
  assert.match(AUTHORITY_USAGE, /^usage: sompi-authority/);
});
