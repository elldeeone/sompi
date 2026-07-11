export const MCP_USAGE = [
  "usage: sompi-mcp [start]",
  "       sompi-mcp gen-wallet-key [testnet-10]",
  "       sompi-mcp gen-owner-key",
  "       sompi-mcp --help",
].join("\n");

export const AUTHORITY_USAGE = [
  "usage: sompi-authority [start]",
  "       sompi-authority init",
  "       sompi-authority --help",
].join("\n");

export type McpCliCommand =
  | Readonly<{ kind: "start" }>
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "generate-wallet-key"; network: "testnet-10" }>
  | Readonly<{ kind: "generate-owner-key" }>;

export type AuthorityCliCommand =
  | Readonly<{ kind: "start" }>
  | Readonly<{ kind: "init" }>
  | Readonly<{ kind: "help" }>;

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

/** Parse the complete MCP argv before any runtime path or state is touched. */
export function parseMcpArguments(
  args: readonly string[],
  environmentNetwork?: string
): McpCliCommand {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new CliArgumentError("sompi-mcp arguments are invalid");
  }
  if (args.length === 0 || (args.length === 1 && args[0] === "start")) {
    return Object.freeze({ kind: "start" as const });
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    return Object.freeze({ kind: "help" as const });
  }
  if (args[0] === "gen-owner-key") {
    if (args.length !== 1) {
      throw new CliArgumentError("gen-owner-key accepts no additional arguments");
    }
    return Object.freeze({ kind: "generate-owner-key" as const });
  }
  if (args[0] === "gen-wallet-key") {
    if (args.length > 2) {
      throw new CliArgumentError("gen-wallet-key accepts at most one network argument");
    }
    const network = args[1] ?? environmentNetwork ?? "testnet-10";
    if (network !== "testnet-10") {
      throw new CliArgumentError(
        "the initial Sompi release can generate wallet keys only for testnet-10"
      );
    }
    return Object.freeze({ kind: "generate-wallet-key" as const, network });
  }
  throw new CliArgumentError("unsupported sompi-mcp command");
}

/** Parse the complete authority argv before deriving or opening authority paths. */
export function parseAuthorityArguments(args: readonly string[]): AuthorityCliCommand {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new CliArgumentError("sompi-authority arguments are invalid");
  }
  if (args.length === 0 || (args.length === 1 && args[0] === "start")) {
    return Object.freeze({ kind: "start" as const });
  }
  if (args.length === 1 && args[0] === "init") {
    return Object.freeze({ kind: "init" as const });
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    return Object.freeze({ kind: "help" as const });
  }
  throw new CliArgumentError("unsupported sompi-authority command");
}
