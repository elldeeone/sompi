#!/usr/bin/env node
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PolicyEngine, PolicyViolation } from "./policy";
import { KaspaWallet, formatKas, parseKasToSompi } from "./wallet";
import { VaultManager } from "./vault";
import { X402Client } from "./x402/client";

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const DATA_DIR = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK);
const NODE_URL = process.env.SOMPI_NODE_URL;
const POLICY_PATH = process.env.SOMPI_POLICY;

const wallet = new KaspaWallet({ networkId: NETWORK, dataDir: DATA_DIR, nodeUrl: NODE_URL });
const policy = new PolicyEngine(DATA_DIR, POLICY_PATH);

const server = new McpServer({ name: "sompi", version: "0.2.1" });

// The SDK's registerTool generics overflow tsc's instantiation depth with
// zod 3.25 shapes, so registrations go through this loosely-typed wrapper.
const registerTool = (
  name: string,
  config: { description: string; inputSchema?: Record<string, z.ZodTypeAny> },
  handler: (args: any) => Promise<unknown>
): void => {
  (server as any).registerTool(name, config, handler);
};

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, bigintSafe, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

function bigintSafe(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function guarded<T>(fn: () => Promise<T>): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof PolicyViolation) return fail(e.message);
    return fail(e instanceof Error ? e.message : String(e));
  }
}

registerTool(
  "get_address",
  {
    description:
      "Get this agent's Kaspa receive address and network. Share this address to receive payments.",
  },
  async () => guarded(async () => ({ address: wallet.address, network: NETWORK }))
);

registerTool(
  "get_balance",
  {
    description:
      "Get the KAS balance of an address (defaults to the agent's own wallet). Returns sompi and KAS.",
    inputSchema: { address: z.string().optional().describe("Kaspa address; omit for own wallet") },
  },
  async ({ address }) =>
    guarded(async () => {
      const sompi = await wallet.balanceSompi(address);
      return { address: address ?? wallet.address, sompi: sompi.toString(), kas: formatKas(sompi) };
    })
);

registerTool(
  "send_payment",
  {
    description:
      "Send KAS to a destination address, subject to the local spending policy " +
      "(per-transaction cap, rolling hourly cap, optional allowlist). " +
      "Specify the amount in sompi (1 KAS = 100,000,000 sompi) or as a KAS decimal string.",
    inputSchema: {
      to: z.string().describe("Destination Kaspa address"),
      amountSompi: z.string().optional().describe("Amount in sompi (integer string)"),
      amountKas: z.string().optional().describe("Amount in KAS (decimal string), alternative to amountSompi"),
    },
  },
  async ({ to, amountSompi, amountKas }) =>
    guarded(async () => {
      if (!amountSompi && !amountKas) throw new Error("provide amountSompi or amountKas");
      const amount = amountSompi ? BigInt(amountSompi) : parseKasToSompi(amountKas!);
      policy.authorize(to, amount);
      const { txid, feeSompi } = await wallet.send(to, amount);
      policy.record(amount);
      return {
        txid,
        to,
        amountSompi: amount.toString(),
        amountKas: formatKas(amount),
        feeSompi: feeSompi.toString(),
        network: NETWORK,
      };
    })
);

registerTool(
  "await_payment",
  {
    description:
      "Wait for an incoming payment of at least the given amount to an address " +
      "(defaults to the agent's own address). Resolves when the payment arrives or the timeout passes.",
    inputSchema: {
      minAmountSompi: z.string().describe("Minimum amount in sompi to wait for"),
      address: z.string().optional().describe("Address to watch; omit for own wallet"),
      timeoutSeconds: z.number().int().min(1).max(600).default(120).describe("How long to wait"),
    },
  },
  async ({ minAmountSompi, address, timeoutSeconds }) =>
    guarded(async () => {
      const result = await wallet.awaitPayment(address ?? wallet.address, BigInt(minAmountSompi), timeoutSeconds * 1000);
      return {
        receivedSompi: result.receivedSompi.toString(),
        receivedKas: formatKas(result.receivedSompi),
        txids: result.txids,
      };
    })
);

registerTool(
  "verify_payment",
  {
    description:
      "Verify that a transaction paid an address: checks the address's current UTXOs for outputs created by the txid.",
    inputSchema: {
      txid: z.string().describe("Transaction id to verify"),
      address: z.string().optional().describe("Receiving address; omit for own wallet"),
    },
  },
  async ({ txid, address }) =>
    guarded(async () => {
      const result = await wallet.verifyPayment(txid, address ?? wallet.address);
      return { found: result.found, amountSompi: result.amountSompi.toString(), amountKas: formatKas(result.amountSompi) };
    })
);

registerTool(
  "estimate_fee",
  {
    description: "Get current network fee estimates (feerate buckets in sompi per gram) from the connected node.",
  },
  async () => guarded(async () => wallet.feeEstimate())
);

registerTool(
  "network_status",
  {
    description: "Get connected node status: network, sync state, virtual DAA score, server version.",
  },
  async () =>
    guarded(async () => {
      const info = await wallet.serverInfo();
      return {
        network: NETWORK,
        isSynced: info.isSynced,
        serverVersion: info.serverVersion,
        virtualDaaScore: info.virtualDaaScore?.toString?.() ?? String(info.virtualDaaScore),
        hasUtxoIndex: info.hasUtxoIndex,
      };
    })
);

const x402 = new X402Client(wallet, policy, DATA_DIR);

registerTool(
  "paid_fetch",
  {
    description:
      "Fetch a URL, automatically paying for it if the server responds with HTTP 402 (kaspa-tab scheme). " +
      "Opens a payment tab with an on-chain KAS deposit (subject to the spending policy), then subsequent " +
      "requests to the same origin are charged against the tab with no on-chain cost.",
    inputSchema: {
      url: z.string().url().describe("URL to fetch"),
      method: z.string().default("GET").describe("HTTP method"),
      body: z.string().optional().describe("Request body"),
    },
  },
  async ({ url, method, body }) =>
    guarded(async () => {
      const result = await x402.paidFetch(url, { method, body });
      return {
        status: result.status,
        body: result.body.length > 10_000 ? result.body.slice(0, 10_000) + "…[truncated]" : result.body,
        tabId: result.tabId,
        remainingSompi: result.remainingSompi,
        deposit: result.deposit,
      };
    })
);

const vault = new VaultManager(DATA_DIR, process.env.SOMPI_VAULT_DRIVER);

registerTool(
  "vault_create",
  {
    description:
      "Create a covenant vault: a P2SH address whose agent spending path is capped at maxOutflowSompi " +
      "per transaction by Kaspa consensus (not by software). The owner/recovery key belongs to your " +
      "HUMAN OPERATOR: before calling this, ask them to run `vault-driver gen-key` on their own machine " +
      "and give you (1) the public key and (2) the spending cap they want. Never generate or ask for " +
      "the owner private key. Returns the vault address for them to fund. " +
      "Requires the vault-driver binary (SOMPI_VAULT_DRIVER). Testnet proof-of-concept.",
    inputSchema: {
      maxOutflowSompi: z.string().describe("Consensus-enforced cap per withdrawal (amount + fee), in sompi — chosen by the operator"),
      ownerPublicKey: z.string().describe("The operator's 32-byte x-only public key (64 hex chars); its private half stays with them"),
    },
  },
  async ({ maxOutflowSompi, ownerPublicKey }) =>
    guarded(async () => {
      const created = vault.create(BigInt(maxOutflowSompi), ownerPublicKey);
      return {
        ...created,
        note: "ask your operator to fund this address; only they can ever drain it past the cap",
      };
    })
);

registerTool(
  "vault_status",
  {
    description: "Show the covenant vault's address, consensus spending cap, and on-chain balance.",
  },
  async () =>
    guarded(async () => {
      if (!vault.configured) return { configured: false };
      const config = vault.config();
      const balance = await vault.balanceSompi(wallet);
      return { configured: true, ...config, balanceSompi: balance.toString(), balanceKas: formatKas(balance) };
    })
);

registerTool(
  "vault_send",
  {
    description:
      "Withdraw from the covenant vault via the consensus-capped agent path. Also passes through the " +
      "local spending policy (defense in depth). Change returns to the vault automatically.",
    inputSchema: {
      to: z.string().describe("Destination Kaspa address"),
      amountSompi: z.string().describe("Amount in sompi"),
      feeSompi: z.string().optional().describe("Fee in sompi (default 2000000)"),
    },
  },
  async ({ to, amountSompi, feeSompi }) =>
    guarded(async () => {
      const amount = BigInt(amountSompi);
      policy.authorize(to, amount);
      const txid = await vault.send(wallet, to, amount, feeSompi ? BigInt(feeSompi) : undefined);
      policy.record(amount);
      return { txid, to, amountSompi: amount.toString(), enforcement: "consensus (covenant) + local policy" };
    })
);

registerTool(
  "get_policy",
  {
    description:
      "Show the active spending policy (read-only): per-transaction cap, hourly cap, current hourly spend, allowlist.",
  },
  async () => guarded(async () => policy.describe())
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; all diagnostics go to stderr.
  console.error(`sompi MCP server ready: network=${NETWORK} address=${wallet.address}`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
