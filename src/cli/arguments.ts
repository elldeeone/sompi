export const MCP_USAGE = [
  "usage: sompi-mcp [start]",
  "       sompi-mcp --help",
].join("\n");

export const AUTHORITY_USAGE = [
  "usage: sompi-authority [start]",
  "       sompi-authority init",
  "       sompi-authority --help",
].join("\n");

export const OPERATOR_USAGE = [
  "usage: sompi-operator preview SPEC.json",
  "       sompi-operator provision SPEC.json CANDIDATE_DIR",
  "       sompi-operator install CANDIDATE_DIR MANIFEST.json EXPECTED_DIGEST OPERATOR_UID RUNTIME_UID RUNTIME_GID",
  "       sompi-operator status MANIFEST.json OPERATOR_UID RUNTIME_UID RUNTIME_GID",
  "       sompi-operator agent-credential FILE OPERATOR_UID RUNTIME_GID",
  "       sompi-operator recovery-credential FILE OPERATOR_UID RECOVERY_GID",
  "       sompi-operator owner-key",
  "       sompi-operator --help",
].join("\n");

export type McpCliCommand =
  | Readonly<{ kind: "start" }>
  | Readonly<{ kind: "help" }>;

export type AuthorityCliCommand =
  | Readonly<{ kind: "start" }>
  | Readonly<{ kind: "init" }>
  | Readonly<{ kind: "help" }>;

export type OperatorCliCommand =
  | Readonly<{ kind: "preview"; spec: string }>
  | Readonly<{ kind: "provision"; spec: string; bundle: string }>
  | Readonly<{ kind: "install"; bundle: string; manifest: string; digest: string; operatorUid: number; runtimeUid: number; runtimeGid: number }>
  | Readonly<{ kind: "status"; manifest: string; operatorUid: number; runtimeUid: number; runtimeGid: number }>
  | Readonly<{ kind: "agent-credential"; filename: string; operatorUid: number; runtimeGid: number }>
  | Readonly<{ kind: "recovery-credential"; filename: string; operatorUid: number; recoveryGid: number }>
  | Readonly<{ kind: "owner-key" }>
  | Readonly<{ kind: "help" }>;

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

/** Parse the complete MCP argv before any runtime path or state is touched. */
export function parseMcpArguments(
  args: readonly string[]
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

/** Parse the isolated operator command before reading specs, keys, or runtime state. */
export function parseOperatorArguments(args: readonly string[]): OperatorCliCommand {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new CliArgumentError("sompi-operator arguments are invalid");
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) return Object.freeze({ kind: "help" });
  if (args.length === 1 && args[0] === "owner-key") return Object.freeze({ kind: "owner-key" });
  if (args.length === 2 && args[0] === "preview") return Object.freeze({ kind: "preview", spec: args[1] });
  if (args.length === 3 && args[0] === "provision") return Object.freeze({ kind: "provision", spec: args[1], bundle: args[2] });
  if (args.length === 5 && args[0] === "status") {
    return Object.freeze({
      kind: "status",
      manifest: args[1],
      operatorUid: numericArgument(args[2], "operator UID"),
      runtimeUid: numericArgument(args[3], "runtime UID"),
      runtimeGid: numericArgument(args[4], "runtime GID"),
    });
  }
  if (args.length === 4 && args[0] === "agent-credential") {
    return Object.freeze({
      kind: "agent-credential",
      filename: args[1],
      operatorUid: numericArgument(args[2], "operator UID"),
      runtimeGid: numericArgument(args[3], "runtime GID"),
    });
  }
  if (args.length === 4 && args[0] === "recovery-credential") {
    return Object.freeze({
      kind: "recovery-credential",
      filename: args[1],
      operatorUid: numericArgument(args[2], "operator UID"),
      recoveryGid: numericArgument(args[3], "recovery GID"),
    });
  }
  if (args.length === 7 && args[0] === "install") {
    return Object.freeze({
      kind: "install", bundle: args[1], manifest: args[2], digest: args[3],
      operatorUid: numericArgument(args[4], "operator UID"), runtimeUid: numericArgument(args[5], "runtime UID"), runtimeGid: numericArgument(args[6], "runtime GID"),
    });
  }
  throw new CliArgumentError("unsupported sompi-operator command");
}

function numericArgument(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new CliArgumentError(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliArgumentError(`${label} is invalid`);
  return parsed;
}
