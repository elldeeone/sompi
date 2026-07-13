#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  CliArgumentError,
  MCP_USAGE,
  parseMcpArguments,
} from "./cli/arguments.js";
import { SompiRuntimeConfigError, purchaseRuntimeConfigFromEnv } from "./runtime/config.js";
import {
  createSompiPurchaseRuntime,
  type SompiPurchaseRuntime,
} from "./runtime/purchase-runtime.js";
import { createSompiMcpServer } from "./mcp/server.js";
import {
  VaultSendTreasuryOperationAdapter,
  VaultDepositTreasuryOperationAdapter,
  WalletTreasuryOperationAdapter,
} from "./treasury/operation-adapters.js";
import { TreasuryOperationModule } from "./treasury/operations.js";
import { generateWalletKey } from "./wallet.js";

const TESTNET = "testnet-10" as const;

const command = parseCommandOrExit();
switch (command.kind) {
  case "help":
    process.stdout.write(`${MCP_USAGE}\n`);
    break;
  case "generate-wallet-key":
    generateWalletKeyCommand(command.network);
    break;
  case "start":
    void main();
    break;
}

function parseCommandOrExit(): ReturnType<typeof parseMcpArguments> {
  try {
    return parseMcpArguments(process.argv.slice(2), process.env.SOMPI_NETWORK);
  } catch (error) {
    if (error instanceof CliArgumentError) {
      process.stderr.write(`fatal: ${error.message}\n${MCP_USAGE}\n`);
      process.exit(2);
    }
    process.stderr.write(`fatal: sompi-mcp arguments could not be parsed\n${MCP_USAGE}\n`);
    process.exit(2);
  }
}

function generateWalletKeyCommand(network = process.env.SOMPI_NETWORK ?? TESTNET): never {
  if (network !== TESTNET) {
    fatal("The initial Sompi release can generate wallet keys only for testnet-10.");
  }
  const key = generateWalletKey(TESTNET);
  console.log(`Agent wallet keypair (${TESTNET}) — generated locally; back up the private line:`);
  console.log(`private: ${key.privateKey}`);
  console.log(`address: ${key.address}`);
  console.log(
    "\nFund the address, then provide SOMPI_PRIVATE_KEY only through the MCP server environment."
  );
  process.exit(0);
}

async function main(): Promise<void> {
  let runtime: SompiPurchaseRuntime | undefined;
  try {
    const config = purchaseRuntimeConfigFromEnv();
    runtime = createSompiPurchaseRuntime(config);
    const treasuryOperations = new TreasuryOperationModule({
      journal: runtime.journal,
      policy: runtime.policy,
      adapters: [
        new WalletTreasuryOperationAdapter(runtime.wallet),
        new VaultSendTreasuryOperationAdapter(runtime.vault, runtime.wallet),
        new VaultDepositTreasuryOperationAdapter(runtime.vault, runtime.wallet),
      ],
      feeCeilingAtomic: config.treasuryOperationFeeCeilingAtomic,
    });
    const server = createSompiMcpServer(runtime, packageVersion(), treasuryOperations);
    const transport = new StdioServerTransport();
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try {
        await server.close();
      } finally {
        await runtime?.close();
      }
    };
    const shutdown = () => {
      void close().then(
        () => process.exit(0),
        () => fatal("Sompi MCP could not close cleanly; inspect its local state before restarting.")
      );
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await server.connect(transport);
    // stdout is exclusively the MCP transport.
    console.error(
      `sompi MCP server ready: network=${TESTNET} address=${runtime.wallet.address}`
    );
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    if (error instanceof SompiRuntimeConfigError) {
      fatal(error.message);
    }
    fatal("Sompi MCP could not start. Inspect the local configuration and service files.");
  }
}

function packageVersion(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const candidate = JSON.parse(
    fs.readFileSync(path.join(directory, "..", "package.json"), "utf8")
  ) as { version?: unknown };
  if (
    typeof candidate.version !== "string" ||
    candidate.version.length === 0 ||
    candidate.version.length > 100
  ) {
    throw new Error("package.json has no valid version");
  }
  return candidate.version;
}

function fatal(message: string): never {
  const safe = message.length <= 1_200 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)
    ? message
    : "Sompi failed safely; inspect the local configuration.";
  console.error(`fatal: ${safe}`);
  process.exit(1);
}
