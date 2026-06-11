#!/usr/bin/env node
/**
 * Minimal MCP stdio driver for testing: spawns the sompi server and invokes
 * one tool.
 *
 * Usage: node scripts/mcp-call.js <tool> ['{"json":"args"}'] [timeoutSeconds]
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const [, , toolName, argsJson = "{}", timeoutArg = "120"] = process.argv;
if (!toolName) {
  console.error("usage: node scripts/mcp-call.js <tool> [argsJson] [timeoutSeconds]");
  process.exit(2);
}
const timeoutMs = Number(timeoutArg) * 1000 + 30_000;

const server = spawn("node", [path.join(__dirname, "..", "dist", "index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
});

const send = (msg) => server.stdin.write(JSON.stringify(msg) + "\n");

let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: JSON.parse(argsJson) },
      });
    } else if (msg.id === 2) {
      const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg);
      console.log(text);
      server.kill();
      process.exit(msg.result?.isError ? 1 : 0);
    }
  }
});

setTimeout(() => {
  console.error("driver timeout");
  server.kill();
  process.exit(1);
}, timeoutMs);

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sompi-driver", version: "0" },
  },
});
