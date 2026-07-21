import * as os from "node:os";
import * as path from "node:path";

import {
  liveBatchReportDigest,
  runLiveBatchProof,
} from "./live-testnet-batch-proof.js";

const options = parseArgs(process.argv.slice(2));
const report = await runLiveBatchProof({
  directory: options.directory,
  sourceWalletDirectory: options.sourceWalletDirectory,
  reportFilename: options.reportFilename,
  onProgress(message) {
    process.stderr.write(`sompi live batch proof: ${message}\n`);
  },
});

process.stdout.write(`${JSON.stringify({
  profile: report.profile,
  report: options.reportFilename,
  reportDigest: liveBatchReportDigest(report),
  claimChannelId: report.claimChannel.channelId,
  claimTransactionId: report.claimChannel.claimTransactionId,
  refundChannelId: report.refundChannel.channelId,
  refundTransactionId: report.refundChannel.refundTransactionId,
}, null, 2)}\n`);

function parseArgs(args: string[]): {
  readonly directory: string;
  readonly sourceWalletDirectory: string;
  readonly reportFilename: string;
} {
  let directory = path.join(os.homedir(), ".local", "state", "sompi", "alpha9-batch-live-proof");
  let sourceWalletDirectory = path.join(os.homedir(), ".sompi", "testnet-10");
  let reportFilename = path.join(
    os.homedir(),
    ".local",
    "state",
    "sompi",
    "reports",
    "alpha9-batch-report.json"
  );
  for (let index = 0; index < args.length; index += 1) {
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
    throw new Error(
      "usage: run-live-testnet-batch-e2e [--directory PATH] [--source-wallet PATH] [--report PATH]"
    );
  }
  if (
    directory === sourceWalletDirectory ||
    directory.startsWith(`${sourceWalletDirectory}${path.sep}`)
  ) {
    throw new Error("live batch proof directory must be separate from the source wallet");
  }
  if (
    reportFilename === directory ||
    reportFilename.startsWith(`${directory}${path.sep}`)
  ) {
    throw new Error("live batch report must be outside the private resumable proof directory");
  }
  return Object.freeze({ directory, sourceWalletDirectory, reportFilename });
}
