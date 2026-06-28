#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PolicyEngine, PolicyViolation } from "./policy";
import { KaspaWallet, formatKas, parseKasToSompi } from "./wallet";
import { VaultManager } from "./vault";
import { X402Client } from "./x402/client";

// Operator-side CLI: `npx @elldeeone/sompi gen-wallet-key [network]` — generate
// the agent's wallet key yourself so you control and can back it up, and know
// the address to fund before wiring up the agent. Import it via SOMPI_PRIVATE_KEY.
if (process.argv[2] === "gen-wallet-key") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { generateWalletKey } = require("./wallet") as typeof import("./wallet");
  const net = process.argv[3] ?? process.env.SOMPI_NETWORK ?? "testnet-10";
  const key = generateWalletKey(net);
  console.log(`Agent wallet keypair (${net}) — generated locally, back up the private line:`);
  console.log(`private: ${key.privateKey}`);
  console.log(`address: ${key.address}`);
  console.log(
    `\nFund the address, then give the agent this key via env:\n` +
      `  SOMPI_PRIVATE_KEY=${key.privateKey}\n` +
      `(set it in the MCP server's env block; never share the private line otherwise).`
  );
  process.exit(0);
}

// Operator-side CLI: `npx @elldeeone/sompi gen-owner-key` — run on the
// HUMAN's machine, before any MCP plumbing starts.
if (process.argv[2] === "gen-owner-key") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { generateOwnerKey } = require("./vault") as typeof import("./vault");
  const key = generateOwnerKey();
  console.log("Vault owner (recovery) keypair — generated locally, never share the private line:");
  console.log(`private: ${key.privateKey}`);
  console.log(`public:  ${key.publicKey}`);
  console.log("\nGive your agent the `public:` line and your chosen cap; store the private line safely.");
  process.exit(0);
}

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const DATA_DIR = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK);
const NODE_URL = process.env.SOMPI_NODE_URL;
const POLICY_PATH = process.env.SOMPI_POLICY;

const wallet = new KaspaWallet({ networkId: NETWORK, dataDir: DATA_DIR, nodeUrl: NODE_URL });
const policy = new PolicyEngine(DATA_DIR, POLICY_PATH);

const server = new McpServer({ name: "sompi", version: packageVersion() });

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

function packageVersion(): string {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version?: unknown };
  if (typeof raw.version !== "string" || raw.version.length === 0) throw new Error("package.json has no version");
  return raw.version;
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

const vault = new VaultManager(DATA_DIR, NETWORK);

registerTool(
  "vault_create",
  {
    description:
      "Create a covenant vault: a P2SH address whose agent spending path is capped at maxOutflowSompi " +
      "per transaction by Kaspa consensus (not by software). The owner/recovery key belongs to your " +
      "HUMAN OPERATOR: before calling this, ask them to run `npx @elldeeone/sompi gen-owner-key` on " +
      "their own machine and give you (1) the public key and (2) the spending cap they want. Never " +
      "generate or ask for the owner private key. Returns the vault address for them to fund. " +
      "Testnet proof-of-concept.",
    inputSchema: {
      maxOutflowSompi: z.string().optional().describe("Consensus-enforced cap per withdrawal (amount + fee), in sompi — chosen by the operator"),
      ownerPublicKey: z.string().optional().describe("The operator's 32-byte x-only public key (64 hex chars); its private half stays with them"),
    },
  },
  async ({ maxOutflowSompi, ownerPublicKey }) =>
    guarded(async () => {
      if (!ownerPublicKey || !maxOutflowSompi) {
        const policyCap = policy.policy.maxSompiPerTx;
        throw new Error(
          "Vault setup needs two things from your human operator. Relay BOTH questions clearly: " +
            "(1) Ask them to run `npx -y @elldeeone/sompi gen-owner-key` on THEIR machine and send you the " +
            "`public:` line (64 hex chars — never the private line). " +
            "(2) Ask what the vault's UNCHANGEABLE disaster cap should be, in sompi. Explain the two layers " +
            `when you ask: their day-to-day spending policy (currently ${policyCap} sompi per tx) stays in ` +
            "force and can be edited anytime; the vault cap is different — it is baked into the vault address " +
            "forever and only limits what a THIEF with this agent's key could take per transaction. It must be " +
            "at or above the day-to-day policy cap, and closer to it is safer (changing it later means creating " +
            "a new vault and moving the funds). " +
            "Then call vault_create again with ownerPublicKey and maxOutflowSompi. " +
            "After it returns the vault address, use vault_deposit to move your funds in."
        );
      }
      const created = vault.create(BigInt(maxOutflowSompi), ownerPublicKey);
      const policyCap = policy.policy.maxSompiPerTx;
      const cap = BigInt(maxOutflowSompi);
      const alignment =
        cap >= policyCap
          ? cap / policyCap > 10n
            ? `note for your operator: the vault cap is ${cap / policyCap}x the day-to-day policy cap ` +
              `(${policyCap} sompi). Day-to-day nothing changes, but a key thief could drain in ` +
              `${cap}-sompi steps; keeping the two caps close is safer.`
            : "vault cap and day-to-day policy are reasonably aligned"
          : `warning: the vault cap (${cap} sompi) is BELOW the day-to-day policy cap (${policyCap} sompi) — ` +
            "withdrawals above the vault cap will be rejected by the network regardless of policy";
      return {
        ...created,
        capAlignment: alignment,
        nextStep:
          "use vault_deposit to move funds in (your operator can also fund the address directly); " +
          "only the operator's key can ever drain the vault past the cap",
      };
    })
);

registerTool(
  "vault_deposit",
  {
    description:
      "Move KAS from this agent's regular wallet INTO its covenant vault. Exempt from the spending " +
      "policy: deposits make funds MORE constrained, not less. Omit amountSompi to deposit everything " +
      "except a working float.",
    inputSchema: {
      amountSompi: z.string().optional().describe("Amount in sompi; omit to deposit all but the float"),
      keepFloatSompi: z.string().default("1000000000").describe("Float to keep in the regular wallet when amountSompi is omitted (default 10 KAS)"),
    },
  },
  async ({ amountSompi, keepFloatSompi }) =>
    guarded(async () => {
      if (!vault.configured) throw new Error("no vault yet — call vault_create first");
      const config = vault.config();
      const balance = await wallet.balanceSompi();
      const amount = amountSompi ? BigInt(amountSompi) : balance - BigInt(keepFloatSompi);
      if (amount <= 0n) {
        throw new Error(`nothing to deposit: wallet holds ${balance} sompi, float is ${keepFloatSompi}`);
      }
      // Deliberately NOT policy-gated: the destination is this agent's own
      // vault, where funds become strictly harder to move.
      const { txid, feeSompi } = await wallet.send(config.address, amount);
      return {
        txid,
        vaultAddress: config.address,
        depositedSompi: amount.toString(),
        depositedKas: formatKas(amount),
        feeSompi: feeSompi.toString(),
        remainingWalletFloat: formatKas(balance - amount - feeSompi),
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
      if (!vault.configured) {
        return {
          configured: false,
          nextStep:
            "no vault yet — call vault_create (it will tell you what to ask your human operator for)",
        };
      }
      const config = vault.config();
      const balance = await vault.balanceSompi(wallet);
      return {
        configured: true,
        ...config,
        balanceSompi: balance.toString(),
        balanceKas: formatKas(balance),
        dayToDayPolicyMaxPerTxSompi: policy.policy.maxSompiPerTx.toString(),
        note: "maxOutflowSompi is the consensus-enforced disaster cap (unchangeable); the policy cap governs normal operation (editable)",
      };
    })
);

registerTool(
  "vault_send",
  {
    description:
      "Withdraw from the covenant vault via the consensus-capped agent path. Also passes through the " +
      "local spending policy (defense in depth). Change returns to the vault automatically. The fee is " +
      'estimated from the node; pass amountSompi "max" to send the largest amount the covenant cap allows.',
    inputSchema: {
      to: z.string().describe("Destination Kaspa address"),
      amountSompi: z.string().describe('Amount in sompi, or "max" for the largest cap-compliant amount'),
    },
  },
  async ({ to, amountSompi }) =>
    guarded(async () => {
      const amount = amountSompi === "max" ? ("max" as const) : BigInt(amountSompi);
      const result = await vault.send(wallet, to, amount, (resolved) => policy.authorize(to, resolved));
      policy.record(result.amountSompi);
      return {
        txid: result.txid,
        to,
        amountSompi: result.amountSompi.toString(),
        amountKas: formatKas(result.amountSompi),
        feeSompi: result.feeSompi.toString(),
        enforcement: "consensus (covenant) + local policy",
      };
    })
);

registerTool(
  "get_policy",
  {
    description:
      "Show the active spending policy (read-only): per-transaction cap, hourly cap, current hourly spend, allowlist. " +
      "The policy belongs to your human operator: never edit the policy file or bypass these tools to get around " +
      "a limit — when something is blocked, report it to your operator and let them decide.",
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
