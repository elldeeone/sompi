import * as assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITY_USAGE,
  CliArgumentError,
  MCP_USAGE,
  parseAuthorityArguments,
  parseMcpArguments,
} from "./arguments.js";

test("MCP CLI accepts only its closed command surface", () => {
  assert.deepEqual(parseMcpArguments([]), { kind: "start" });
  assert.deepEqual(parseMcpArguments(["start"]), { kind: "start" });
  assert.deepEqual(parseMcpArguments(["--help"]), { kind: "help" });
  assert.deepEqual(parseMcpArguments(["help"]), { kind: "help" });
  assert.deepEqual(parseMcpArguments(["gen-owner-key"]), {
    kind: "generate-owner-key",
  });
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
    ["gen-owner-key", "extra"],
    ["gen-wallet-key", "mainnet"],
    ["gen-wallet-key", "testnet-10", "extra"],
  ]) {
    assert.throws(() => parseMcpArguments(args), CliArgumentError);
  }
  assert.match(MCP_USAGE, /^usage: sompi-mcp/);
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
