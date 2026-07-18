#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

import { authorityClientRuntimePaths } from "../authority/runtime.js";
import { runHumanPresentAuthorityProof } from "./human-present-authority-proof.js";
import { writeLocalTestnetProofReport } from "./local-testnet-proof.js";

if (process.argv.length !== 3 || process.argv[2] !== "run") {
  process.stderr.write("usage: human-present-authority-proof-main.js run\n");
  process.exit(2);
}
void run().catch(() => {
  process.stderr.write("human-present authority proof failed safely\n");
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const directory = requiredAbsolutePath(
    process.env.SOMPI_HUMAN_PROOF_DIRECTORY,
    "SOMPI_HUMAN_PROOF_DIRECTORY"
  );
  const reportPath = requiredAbsolutePath(
    process.env.SOMPI_HUMAN_PROOF_REPORT,
    "SOMPI_HUMAN_PROOF_REPORT"
  );
  if (reportPath !== path.join(directory, "local-proof.json") || fs.existsSync(reportPath)) {
    throw new Error("human-present proof report path is invalid");
  }
  const clientDirectory = requiredAbsolutePath(
    process.env.SOMPI_AUTHORITY_CLIENT_DIR,
    "SOMPI_AUTHORITY_CLIENT_DIR"
  );
  const runtimeDirectory = requiredAbsolutePath(
    process.env.SOMPI_AUTHORITY_RUNTIME_DIR,
    "SOMPI_AUTHORITY_RUNTIME_DIR"
  );
  const socketPath = requiredAbsolutePath(
    process.env.SOMPI_AUTHORITY_SOCKET,
    "SOMPI_AUTHORITY_SOCKET"
  );
  const issuer = requiredIdentity(
    process.env.SOMPI_AUTHORITY_ISSUER,
    "SOMPI_AUTHORITY_ISSUER"
  );
  const keyId = requiredIpcKeyId(
    process.env.SOMPI_AUTHORITY_IPC_KEY_ID,
    "SOMPI_AUTHORITY_IPC_KEY_ID"
  );
  const instrumentId = requiredIdentity(
    process.env.SOMPI_AUTHORITY_INSTRUMENT_ID,
    "SOMPI_AUTHORITY_INSTRUMENT_ID"
  );
  const report = await runHumanPresentAuthorityProof({
    directory,
    authority: {
      paths: authorityClientRuntimePaths({
        clientDirectory,
        runtimeDirectory,
        socketPath,
      }),
      expectedSocketOwnerUserId: requiredNumericId(
        process.env.SOMPI_AUTHORITY_SOCKET_UID,
        "SOMPI_AUTHORITY_SOCKET_UID"
      ),
      socketGroupId: requiredNumericId(
        process.env.SOMPI_AUTHORITY_SOCKET_GID,
        "SOMPI_AUTHORITY_SOCKET_GID"
      ),
      issuer,
      keyId,
      instrumentId,
    },
    now: Date.now,
  });
  writeLocalTestnetProofReport(reportPath, report);
  process.stderr.write("human-present Purchase reached receipted state\n");
}

function requiredAbsolutePath(value: string | undefined, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requiredIdentity(value: string | undefined, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requiredIpcKeyId(value: string | undefined, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requiredNumericId(value: string | undefined, name: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0x7fffffff) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}
