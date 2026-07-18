import * as path from "node:path";

export const AGENT_USAGE = [
  "usage:",
  "  sompi-agent purchase --request-key KEY --url URL [--method METHOD] [--media-type TYPE] [--body-file ABSOLUTE_PATH] [--merchant-id ID] [--merchant-origin ORIGIN]",
  "  sompi-agent status PURCHASE_ID",
  "  sompi-agent recover PURCHASE_ID",
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
  | Readonly<{ kind: "status" | "recover"; purchaseId: string }>;

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
