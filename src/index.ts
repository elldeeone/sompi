#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SompiApiClient } from "./api/client.js";
import { SompiApiConfigError, sompiApiConnectionConfigFromEnv } from "./api/config.js";
import { CliArgumentError, MCP_USAGE, parseMcpArguments } from "./cli/arguments.js";
import { createSompiMcpServer } from "./mcp/server.js";

let command: ReturnType<typeof parseMcpArguments>;
try {
  command = parseMcpArguments(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliArgumentError) {
    process.stderr.write(`fatal: ${error.message}\n${MCP_USAGE}\n`);
    process.exit(2);
  }
  process.stderr.write(`fatal: sompi-mcp arguments could not be parsed\n${MCP_USAGE}\n`);
  process.exit(2);
}

if (command.kind === "help") {
  process.stdout.write(`${MCP_USAGE}\n`);
} else {
  void main();
}

async function main(): Promise<void> {
  try {
    const config = sompiApiConnectionConfigFromEnv();
    const server = createSompiMcpServer(new SompiApiClient(config), packageVersion());
    const transport = new StdioServerTransport();
    let closing = false;
    const close = async () => { if (!closing) { closing = true; await server.close(); } };
    const shutdown = () => { void close().then(() => process.exit(0), () => fatal("Sompi MCP could not close cleanly.")); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await server.connect(transport);
    console.error("sompi MCP compatibility adapter ready on the configured local API socket");
  } catch (error) {
    if (error instanceof SompiApiConfigError) fatal(error.message);
    fatal("Sompi MCP could not start. Inspect the local API configuration.");
  }
}

function packageVersion(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const candidate = JSON.parse(fs.readFileSync(path.join(directory, "..", "package.json"), "utf8")) as { version?: unknown };
  if (typeof candidate.version !== "string" || !candidate.version || candidate.version.length > 100) throw new Error("package version is invalid");
  return candidate.version;
}

function fatal(message: string): never {
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
}
