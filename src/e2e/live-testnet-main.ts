import * as os from "node:os";
import * as path from "node:path";

import {
  createExternalLiveAuthority,
  liveReportDigest,
  runLiveTestnetProof,
} from "./live-testnet-proof.js";

const options = parseArgs(process.argv.slice(2));
const report = await runLiveTestnetProof({
  directory: options.directory,
  sourceWalletDirectory: options.sourceWalletDirectory,
  reportFilename: options.reportFilename,
  exactProfile: options.exactProfile,
  purchaseIngress: options.purchaseIngress,
  ...(options.humanPresentAuthority
    ? { authority: externalAuthority(options.directory) }
    : {}),
  onProgress(message) {
    process.stderr.write(`sompi live proof: ${message}\n`);
  },
});

process.stdout.write(`${JSON.stringify({
  profile: report.profile,
  report: options.reportFilename,
  reportDigest: liveReportDigest(report),
  purchaseId: report.purchase.id,
  state: report.purchase.state,
  exactTransactionId: report.transactions.exactTransactionId,
  merchantOutpoint: report.transactions.merchantOutpoint,
}, null, 2)}\n`);

function parseArgs(args: string[]): {
  readonly directory: string;
  readonly sourceWalletDirectory: string;
  readonly reportFilename: string;
  readonly exactProfile: "standard-native" | "additive";
  readonly purchaseIngress: "http-api" | "mcp-api-compatibility";
  readonly humanPresentAuthority: boolean;
} {
  let exactProfile: "standard-native" | "additive" = "standard-native";
  let purchaseIngress: "http-api" | "mcp-api-compatibility" = "http-api";
  let directory = path.join(os.homedir(), ".local", "state", "sompi", "alpha8-standard-live-proof");
  let sourceWalletDirectory = path.join(os.homedir(), ".sompi", "testnet-10");
  let reportFilename = path.resolve("evidence", "live-testnet10", "alpha8-standard-report.json");
  let humanPresentAuthority = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--directory" && value) {
      directory = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--source-wallet" && value) {
      sourceWalletDirectory = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--report" && value) {
      reportFilename = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--profile" && (value === "standard-native" || value === "additive")) {
      exactProfile = value;
      index += 1;
      continue;
    }
    if (argument === "--ingress" && (value === "http-api" || value === "mcp-api-compatibility")) {
      purchaseIngress = value;
      index += 1;
      continue;
    }
    if (argument === "--human-present-authority") {
      humanPresentAuthority = true;
      continue;
    }
    throw new Error(
      "usage: run-live-testnet-e2e [--directory PATH] [--source-wallet PATH] [--report PATH] " +
        "[--profile standard-native|additive] [--ingress http-api|mcp-api-compatibility] " +
        "[--human-present-authority]"
    );
  }
  if (directory === sourceWalletDirectory || directory.startsWith(`${sourceWalletDirectory}${path.sep}`)) {
    throw new Error("live proof directory must be separate from the existing source wallet");
  }
  return Object.freeze({
    directory,
    sourceWalletDirectory,
    reportFilename,
    exactProfile,
    purchaseIngress,
    humanPresentAuthority,
  });
}

function externalAuthority(directory: string) {
  return createExternalLiveAuthority({
    clientDirectory: requiredAbsoluteEnvironmentPath("SOMPI_AUTHORITY_CLIENT_DIR"),
    socketPath: requiredAbsoluteEnvironmentPath("SOMPI_AUTHORITY_SOCKET"),
    expectedSocketOwnerUserId: requiredNumericEnvironment("SOMPI_AUTHORITY_SOCKET_UID"),
    socketGroupId: requiredNumericEnvironment("SOMPI_AUTHORITY_SOCKET_GID"),
    issuer: requiredIdentityEnvironment("SOMPI_AUTHORITY_ISSUER"),
    keyId: requiredIdentityEnvironment("SOMPI_AUTHORITY_IPC_KEY_ID", 80),
    instrumentId: requiredIdentityEnvironment("SOMPI_AUTHORITY_INSTRUMENT_ID"),
    replayStorePath: path.join(directory, "authority-client-replay.sqlite"),
  });
}

function requiredAbsoluteEnvironmentPath(name: string): string {
  const value = process.env[name];
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

function requiredNumericEnvironment(name: string): number {
  const value = process.env[name];
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0x7fffffff) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

function requiredIdentityEnvironment(name: string, maxLength = 256): string {
  const value = process.env[name];
  const pattern = maxLength === 80
    ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
    : /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
  if (typeof value !== "string" || value.length > maxLength || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
