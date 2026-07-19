#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  sompiApiListenerConfigFromEnv,
  sompiRecoveryApiListenerConfigFromEnv,
  SompiApiConfigError,
} from "./api/config.js";
import { createSompiApplication } from "./api/contracts.js";
import { startSompiApiServer, startSompiRecoveryApiServer } from "./api/server.js";
import { SompiRuntimeConfigError, purchaseRuntimeConfigFromEnv } from "./runtime/config.js";
import { createSompiPurchaseRuntime } from "./runtime/purchase-runtime.js";

if (process.argv.length > 3 || (process.argv[2] && !["start", "help", "--help"].includes(process.argv[2]))) {
  fatal("usage: sompi-api [start|--help]", 2);
}
if (process.argv[2] === "help" || process.argv[2] === "--help") {
  process.stdout.write("usage: sompi-api [start]\n");
} else {
  void main();
}

async function main(): Promise<void> {
  let runtime: ReturnType<typeof createSompiPurchaseRuntime> | undefined;
  let api: Awaited<ReturnType<typeof startSompiApiServer>> | undefined;
  let recoveryApi: Awaited<ReturnType<typeof startSompiRecoveryApiServer>> | undefined;
  try {
    const listener = sompiApiListenerConfigFromEnv();
    const recoveryListener = sompiRecoveryApiListenerConfigFromEnv();
    runtime = createSompiPurchaseRuntime(purchaseRuntimeConfigFromEnv());
    const application = createSompiApplication(runtime.purchase, runtime.transfer, runtime.walletView);
    recoveryApi = await startSompiRecoveryApiServer({
      application,
      credential: recoveryListener.credential,
      socketPath: recoveryListener.socketPath,
      expectedServerUserId: recoveryListener.expectedServerUserId,
      runtimeGroupId: recoveryListener.runtimeGroupId,
      deadlineMs: recoveryListener.deadlineMs,
      maxControlConcurrency: recoveryListener.maxControlConcurrency,
      maxConnections: recoveryListener.maxConnections,
    });
    api = await startSompiApiServer({
      application,
      credential: listener.credential,
      socketPath: listener.socketPath,
      expectedServerUserId: listener.expectedServerUserId,
      runtimeGroupId: listener.runtimeGroupId,
      deadlineMs: listener.deadlineMs,
      maxMutationConcurrency: listener.maxMutationConcurrency,
      maxControlConcurrency: listener.maxControlConcurrency,
    });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await api?.close();
      await recoveryApi?.close();
      await runtime?.close();
    };
    const shutdown = () => { void close().then(() => process.exit(0), () => fatal("Sompi API could not close cleanly.")); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    console.error(`sompi API ${packageVersion()} ready on its configured local socket`);
  } catch (error) {
    await api?.close().catch(() => undefined);
    await recoveryApi?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    if (error instanceof SompiApiConfigError || error instanceof SompiRuntimeConfigError) fatal(error.message);
    fatal("Sompi API could not start. Inspect the local operator configuration.");
  }
}

function packageVersion(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const value = JSON.parse(fs.readFileSync(path.join(directory, "..", "package.json"), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !value.version || value.version.length > 100) throw new Error("package version is invalid");
  return value.version;
}

function fatal(message: string, code = 1): never {
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(code);
}
