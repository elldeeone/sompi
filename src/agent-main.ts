#!/usr/bin/env node
import * as fs from "node:fs";

import { SompiApiClient, SompiApiClientError } from "./api/client.js";
import { MAX_PURCHASE_BODY_BYTES, type PurchaseCreateRequest } from "./api/contracts.js";
import { SompiApiConfigError, sompiApiConnectionConfigFromEnv } from "./api/config.js";
import { kasAmountView, parseKasAmount } from "./amount-display.js";
import {
  AGENT_USAGE,
  AgentCliArgumentError,
  parseAgentArguments,
} from "./cli/agent-arguments.js";
import {
  runPurchaseCommand,
  runPurchaseRecoveryCommand,
} from "./cli/purchase-continuation.js";
import {
  runTransferCommand,
  runTransferRecoveryCommand,
} from "./cli/transfer-continuation.js";

void main().catch((error: unknown) => {
  if (error instanceof AgentCliArgumentError || error instanceof SompiApiConfigError) {
    fatal(error.message, error instanceof AgentCliArgumentError ? 2 : 1);
  }
  if (error instanceof SompiApiClientError) {
    fatal(`${error.code}: ${error.message}`, error.retryable ? 75 : 1);
  }
  fatal("Sompi could not complete the local Sompi API request.");
});

async function main(): Promise<void> {
  const command = parseAgentArguments(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${AGENT_USAGE}\n`);
    return;
  }
  const client = new SompiApiClient(sompiApiConnectionConfigFromEnv());
  const view = command.kind === "purchase"
    ? await runPurchaseCommand(client, purchaseRequest(command))
    : command.kind === "status"
      ? await client.status(command.purchaseId)
      : command.kind === "recover"
        ? await runPurchaseRecoveryCommand(client, command.purchaseId)
        : command.kind === "wallet"
          ? await client.wallet()
          : command.kind === "wallet-technical"
            ? await client.walletTechnical()
          : command.kind === "activity"
            ? await client.activity(command.limit)
            : command.kind === "transfer"
              ? await runTransferCommand(client, {
                  requestKey: command.requestKey,
                  destination: command.destination,
                  amountKas: transferAmountKas(command),
                })
              : command.kind === "transfer-status"
                ? await client.transferStatus(command.transferId)
              : command.kind === "transfer-recover"
                ? await runTransferRecoveryCommand(client, command.transferId)
                : command.kind === "change-limits"
                  ? await client.changePolicy({ requestKey: command.requestKey, maximumPerPaymentKas: command.maximumPerPaymentKas, maximumPerHourKas: command.maximumPerHourKas })
                  : command.kind === "limit-change-status"
                    ? await client.policyChangeStatus(command.policyChangeId)
                    : command.kind === "limit-change-recover"
                      ? await client.policyChangeRecover(command.policyChangeId)
                    : command.kind === "change-vault-protection"
                      ? await client.vaultMigration({ requestKey: command.requestKey, vaultProtectionMaximumKas: command.vaultProtectionMaximumKas })
                      : command.kind === "vault-protection-change-status"
                        ? await client.vaultMigrationStatus(command.vaultMigrationId)
                  : unreachable(command);
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
}

function unreachable(value: never): never {
  throw new AgentCliArgumentError(`unsupported command: ${JSON.stringify(value)}`);
}

function transferAmountKas(command: Extract<ReturnType<typeof parseAgentArguments>, { kind: "transfer" }>): string {
  if (command.amountSompi !== undefined) {
    if (!/^[1-9][0-9]{0,19}$/.test(command.amountSompi)) {
      throw new AgentCliArgumentError("--amount-sompi must be a positive canonical integer");
    }
    const amount = BigInt(command.amountSompi);
    if (amount > (1n << 64n) - 1n) throw new AgentCliArgumentError("transfer amount exceeds uint64");
    return kasAmountView(amount).kas;
  }
  try {
    return kasAmountView(parseKasAmount(command.amountKas ?? "")).kas;
  } catch (cause) {
    throw new AgentCliArgumentError(cause instanceof Error ? `--amount-kas ${cause.message}` : "--amount-kas is invalid");
  }
}

function purchaseRequest(command: Extract<ReturnType<typeof parseAgentArguments>, { kind: "purchase" }>): PurchaseCreateRequest {
  let body: Buffer | undefined;
  try {
    if (command.bodyFile) body = readBoundedRegularFile(command.bodyFile);
    return Object.freeze({
      requestKey: command.requestKey,
      url: command.url,
      ...(command.method ? { method: command.method } : {}),
      ...(command.mediaType ? { mediaType: command.mediaType } : {}),
      ...(body ? { bodyBase64: body.toString("base64") } : {}),
      ...(command.merchantId || command.merchantOrigin
        ? {
            expectedMerchant: Object.freeze({
              ...(command.merchantId ? { id: command.merchantId } : {}),
              ...(command.merchantOrigin ? { origin: command.merchantOrigin } : {}),
            }),
          }
        : {}),
    });
  } finally {
    body?.fill(0);
  }
}

function readBoundedRegularFile(filename: string): Buffer {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_PURCHASE_BODY_BYTES) {
      throw new AgentCliArgumentError("--body-file must be a bounded regular file");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new AgentCliArgumentError("--body-file was truncated");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) {
      bytes.fill(0);
      throw new AgentCliArgumentError("--body-file changed during its stable read");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function fatal(message: string, code = 1): never {
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(code);
}
