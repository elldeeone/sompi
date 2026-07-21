import * as os from "node:os";
import * as path from "node:path";

import {
  liveAdditiveContentionReportDigest,
  runLiveAdditiveContentionProof,
} from "./live-testnet-additive-contention.js";

const options = parseArgs(process.argv.slice(2));
const report = await runLiveAdditiveContentionProof({
  ...options,
  onProgress(message) {
    process.stderr.write(`sompi additive contention proof: ${message}\n`);
  },
});

process.stdout.write(`${JSON.stringify({
  profile: report.profile,
  report: options.reportFilename,
  reportDigest: liveAdditiveContentionReportDigest(report),
  winnerTransactionId: report.winner.transactionId,
  losingTransactionId: report.loser.transactionId,
  retryTransactionId: report.explicitRetry.transactionId,
}, null, 2)}\n`);

function parseArgs(args: string[]) {
  let directory = path.join(os.homedir(), ".local", "state", "sompi", "alpha9-additive-contention-live-proof");
  let sourceWalletDirectory = path.join(os.homedir(), ".sompi", "testnet-10");
  let reportFilename = path.join(
    os.homedir(), ".local", "state", "sompi", "reports", "alpha9-additive-contention-report.json"
  );
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
    throw new Error(
      "usage: run-live-testnet-additive-contention [--directory PATH] [--source-wallet PATH] [--report PATH]"
    );
  }
  return Object.freeze({ directory, sourceWalletDirectory, reportFilename });
}
