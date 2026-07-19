import * as path from "node:path";

export const AGENT_USAGE = [
  "usage:",
  "  sompi-agent purchase --request-key KEY --url URL [--method METHOD] [--media-type TYPE] [--body-file ABSOLUTE_PATH] [--merchant-id ID] [--merchant-origin ORIGIN]",
  "  sompi-agent status PURCHASE_ID",
  "  sompi-agent recover PURCHASE_ID",
  "  sompi-agent wallet",
  "  sompi-agent activity [--limit 1..100]",
  "  sompi-agent transfer --request-key KEY --to KASPATEST_ADDRESS (--amount-kas KAS | --amount-sompi SOMPI)",
  "  sompi-agent transfer-status TRANSFER_ID",
  "  sompi-agent transfer-recover TRANSFER_ID",
  "  sompi-agent --help",
].join("\n");

export type AgentCliCommand =
  | Readonly<{ kind: "help" }>
  | Readonly<{
      kind: "purchase";
      requestKey: string;
      url: string;
      method?: string;
      mediaType?: string;
      bodyFile?: string;
      merchantId?: string;
      merchantOrigin?: string;
    }>
  | Readonly<{ kind: "status"; purchaseId: string }>
  | Readonly<{ kind: "recover"; purchaseId: string }>
  | Readonly<{ kind: "wallet" }>
  | Readonly<{ kind: "activity"; limit: number }>
  | Readonly<{
      kind: "transfer";
      requestKey: string;
      destination: string;
      amountKas?: string;
      amountSompi?: string;
    }>
  | Readonly<{ kind: "transfer-status"; transferId: string }>
  | Readonly<{ kind: "transfer-recover"; transferId: string }>;

export class AgentCliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCliArgumentError";
  }
}

export function parseAgentArguments(args: readonly string[]): AgentCliCommand {
  if (args.length === 1 && (args[0] === "help" || args[0] === "--help")) {
    return Object.freeze({ kind: "help" });
  }
  if (args[0] === "status" || args[0] === "recover") {
    if (args.length !== 2 || !args[1]) throw new AgentCliArgumentError(`${args[0]} requires one Purchase ID`);
    return Object.freeze({ kind: args[0], purchaseId: args[1] });
  }
  if (args[0] === "wallet") {
    if (args.length !== 1) throw new AgentCliArgumentError("wallet does not accept arguments");
    return Object.freeze({ kind: "wallet" });
  }
  if (args[0] === "activity") {
    if (args.length === 1) return Object.freeze({ kind: "activity", limit: 20 });
    if (args.length !== 3 || args[1] !== "--limit" || !args[2] || !/^[1-9][0-9]{0,2}$/.test(args[2])) {
      throw new AgentCliArgumentError("activity accepts only --limit 1..100");
    }
    const limit = Number(args[2]);
    if (limit > 100) throw new AgentCliArgumentError("activity limit must be between 1 and 100");
    return Object.freeze({ kind: "activity", limit });
  }
  if (args[0] === "transfer-status" || args[0] === "transfer-recover") {
    if (args.length !== 2 || !args[1]) throw new AgentCliArgumentError(`${args[0]} requires one Transfer ID`);
    return Object.freeze({ kind: args[0], transferId: args[1] });
  }
  if (args[0] === "transfer") return parseTransferArguments(args.slice(1));
  if (args[0] !== "purchase") throw new AgentCliArgumentError("unknown or missing command");
  const values = new Map<string, string>();
  const allowed = new Set([
    "--request-key", "--url", "--method", "--media-type", "--body-file",
    "--merchant-id", "--merchant-origin",
  ]);
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !allowed.has(option) || !value || value.startsWith("--")) {
      throw new AgentCliArgumentError("purchase options must be known name/value pairs");
    }
    if (values.has(option)) throw new AgentCliArgumentError(`${option} was supplied more than once`);
    values.set(option, value);
  }
  const requestKey = values.get("--request-key");
  const url = values.get("--url");
  if (!requestKey || !url) throw new AgentCliArgumentError("purchase requires --request-key and --url");
  const bodyFile = values.get("--body-file");
  if (bodyFile && (!path.isAbsolute(bodyFile) || path.resolve(bodyFile) !== bodyFile)) {
    throw new AgentCliArgumentError("--body-file must be a canonical absolute path");
  }
  return Object.freeze({
    kind: "purchase",
    requestKey,
    url,
    ...(values.has("--method") ? { method: values.get("--method")! } : {}),
    ...(values.has("--media-type") ? { mediaType: values.get("--media-type")! } : {}),
    ...(bodyFile ? { bodyFile } : {}),
    ...(values.has("--merchant-id") ? { merchantId: values.get("--merchant-id")! } : {}),
    ...(values.has("--merchant-origin") ? { merchantOrigin: values.get("--merchant-origin")! } : {}),
  });
}

function parseTransferArguments(args: readonly string[]): AgentCliCommand {
  const values = new Map<string, string>();
  const allowed = new Set(["--request-key", "--to", "--amount-kas", "--amount-sompi"]);
  if (args.length === 0 || args.length % 2 !== 0) {
    throw new AgentCliArgumentError("transfer options must be known name/value pairs");
  }
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !allowed.has(option) || !value || value.startsWith("--")) {
      throw new AgentCliArgumentError("transfer options must be known name/value pairs");
    }
    if (values.has(option)) throw new AgentCliArgumentError(`${option} was supplied more than once`);
    values.set(option, value);
  }
  const requestKey = values.get("--request-key");
  const destination = values.get("--to");
  const amountKas = values.get("--amount-kas");
  const amountSompi = values.get("--amount-sompi");
  if (!requestKey || !destination || Boolean(amountKas) === Boolean(amountSompi)) {
    throw new AgentCliArgumentError("transfer requires --request-key, --to, and exactly one amount option");
  }
  return Object.freeze({
    kind: "transfer",
    requestKey,
    destination,
    ...(amountKas ? { amountKas } : { amountSompi: amountSompi! }),
  });
}
