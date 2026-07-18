#!/usr/bin/env node
import * as fs from "node:fs";

import { PurchaseApiClient, PurchaseApiClientError } from "./api/client.js";
import { MAX_PURCHASE_BODY_BYTES, type PurchaseCreateRequest } from "./api/contracts.js";
import { PurchaseApiConfigError, purchaseApiConnectionConfigFromEnv } from "./api/config.js";
import {
  AGENT_USAGE,
  AgentCliArgumentError,
  parseAgentArguments,
} from "./cli/agent-arguments.js";

void main().catch((error: unknown) => {
  if (error instanceof AgentCliArgumentError || error instanceof PurchaseApiConfigError) {
    fatal(error.message, error instanceof AgentCliArgumentError ? 2 : 1);
  }
  if (error instanceof PurchaseApiClientError) {
    fatal(`${error.code}: ${error.message}`, error.retryable ? 75 : 1);
  }
  fatal("Sompi could not complete the local Purchase API request.");
});

async function main(): Promise<void> {
  const command = parseAgentArguments(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${AGENT_USAGE}\n`);
    return;
  }
  const client = new PurchaseApiClient(purchaseApiConnectionConfigFromEnv());
  const view = command.kind === "purchase"
    ? await client.purchase(purchaseRequest(command))
    : command.kind === "status"
      ? await client.status(command.purchaseId)
      : await client.recover(command.purchaseId);
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
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
