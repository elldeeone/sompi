#!/usr/bin/env node
import {
  authorityRuntimePaths,
  initializeAuthorityRuntime,
  startAuthorityRuntime,
} from "./authority/runtime.js";
import {
  AUTHORITY_USAGE,
  CliArgumentError,
  parseAuthorityArguments,
  type AuthorityCliCommand,
} from "./cli/arguments.js";

const command = parseCommandOrExit();
if (command.kind === "help") {
  process.stdout.write(`${AUTHORITY_USAGE}\n`);
} else {
  void main(command).catch(() => {
    process.stderr.write("sompi-authority failed to initialize or serve; inspect the operator runbook and secure configuration\n");
    process.exitCode = 1;
  });
}

function parseCommandOrExit(): AuthorityCliCommand {
  try {
    return parseAuthorityArguments(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof CliArgumentError
        ? error.message
        : "sompi-authority arguments could not be parsed";
    process.stderr.write(`fatal: ${message}\n${AUTHORITY_USAGE}\n`);
    process.exit(2);
  }
}

async function main(command: Exclude<AuthorityCliCommand, { kind: "help" }>): Promise<void> {
  const paths = authorityRuntimePaths({
    ...(process.env.SOMPI_AUTHORITY_ROOT_DIR
      ? { rootDirectory: process.env.SOMPI_AUTHORITY_ROOT_DIR }
      : {}),
    ...(process.env.SOMPI_AUTHORITY_PRIVATE_DIR
      ? { privateDirectory: process.env.SOMPI_AUTHORITY_PRIVATE_DIR }
      : {}),
    ...(process.env.SOMPI_AUTHORITY_CLIENT_DIR
      ? { clientDirectory: process.env.SOMPI_AUTHORITY_CLIENT_DIR }
      : {}),
    ...(process.env.SOMPI_AUTHORITY_RUNTIME_DIR
      ? { runtimeDirectory: process.env.SOMPI_AUTHORITY_RUNTIME_DIR }
      : {}),
    ...(process.env.SOMPI_AUTHORITY_SOCKET
      ? { socketPath: process.env.SOMPI_AUTHORITY_SOCKET }
      : {}),
  });
  const identity = {
    issuer: process.env.SOMPI_AUTHORITY_ISSUER ?? "urn:sompi:authority:local",
    kid: process.env.SOMPI_AUTHORITY_SIGNING_KID ?? "authority-signing-key-1",
    keyId: process.env.SOMPI_AUTHORITY_IPC_KEY_ID ?? "authority-ipc-key-1",
    instrumentId: process.env.SOMPI_AUTHORITY_INSTRUMENT_ID ?? "kaspa:testnet-10:vault-treasury",
  };
  if (command.kind === "init") {
    const trust = await initializeAuthorityRuntime(paths, identity);
    process.stdout.write(`${JSON.stringify({
      status: "initialized",
      privateDirectory: paths.privateDirectory,
      clientDirectory: paths.clientDirectory,
      runtimeDirectory: paths.runtimeDirectory,
      publicTrustEntry: trust,
      next: "Add trusted Merchant checkout/receipt public keys to trust.json before starting.",
    }, null, 2)}\n`);
    return;
  }
  const socketGroupId = optionalNumericId(
    process.env.SOMPI_AUTHORITY_SOCKET_GID,
    "authority socket group ID"
  );
  const authority = await startAuthorityRuntime(paths, identity, {
    ...(socketGroupId === undefined ? {} : { socketGroupId }),
  });
  process.stderr.write("sompi-authority listening on its configured Unix socket\n");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await authority.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

function optionalNumericId(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0x7fffffff) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}
