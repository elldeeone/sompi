import * as os from "node:os";
import * as path from "node:path";

import {
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
} {
  let exactProfile: "standard-native" | "additive" = "standard-native";
  let purchaseIngress: "http-api" | "mcp-api-compatibility" = "http-api";
  let directory = path.join(os.homedir(), ".local", "state", "sompi", "alpha8-standard-live-proof");
  let sourceWalletDirectory = path.join(os.homedir(), ".sompi", "testnet-10");
  let reportFilename = path.resolve("evidence", "live-testnet10", "alpha8-standard-report.json");
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
    throw new Error(
      "usage: run-live-testnet-e2e [--directory PATH] [--source-wallet PATH] [--report PATH] " +
        "[--profile standard-native|additive] [--ingress http-api|mcp-api-compatibility]"
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
  });
}
