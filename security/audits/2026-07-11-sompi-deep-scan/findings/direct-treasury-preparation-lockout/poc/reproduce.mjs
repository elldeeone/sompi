import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = path.resolve(process.cwd(), process.argv[2] ?? "../target");
const revision = "4ebb82d4f82bac46ae3addd112c4752f29630a8a";

if (!fs.existsSync(path.join(target, "dist", "treasury", "operations.js"))) {
  throw new Error(
    `Sompi is not built at ${target}. Run npm ci and npm run build in the target checkout first.`,
  );
}

// Git archives do not carry .git metadata. When metadata is present, enforce
// the reviewed revision here as well as in the README's preparation commands.
if (fs.existsSync(path.join(target, ".git"))) {
  const actualRevision = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.equal(actualRevision, revision, "the PoC must run against the reviewed revision");
}

const fromDist = (relative) =>
  import(pathToFileURL(path.join(target, "dist", relative)).href);
const { payToAddressScript } = await fromDist("kaspa-wasm.js");
const { KaspaWallet } = await fromDist("wallet.js");
const { WalletTreasuryOperationAdapter } = await fromDist(
  "treasury/operation-adapters.js",
);
const { PurchaseJournal } = await fromDist("purchase/journal.js");
const { PolicyEngine } = await fromDist("policy.js");
const { TreasuryOperationModule } = await fromDist("treasury/operations.js");
const { registerSompiTools } = await fromDist("mcp/server.js");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-can-031-"));
const destination = "kaspatest:a";
const policyPath = path.join(directory, "policy.json");
fs.writeFileSync(
  policyPath,
  JSON.stringify({
    maxSompiPerTx: "1000",
    maxSompiPerHour: "1000",
    allowlist: [destination],
    requireApprovalAboveSompi: "0",
  }),
  { mode: 0o600 },
);

const policy = new PolicyEngine(directory, policyPath);
const wallet = new KaspaWallet({
  networkId: "testnet-10",
  dataDir: path.join(directory, "wallet"),
});
const sourceScript = payToAddressScript(wallet.address);
let prepareCalls = 0;
let submitCalls = 0;
const preparationErrors = [];

wallet.client = async () => ({
  getBlockDagInfo: async () => ({ sink: "aa".repeat(32) }),
  getUtxosByAddresses: async () => ({
    entries: [
      {
        outpoint: { transactionId: "77".repeat(32), index: 0 },
        amount: 300_000_000n,
        scriptPublicKey: sourceScript,
        blockDaaScore: 1n,
        isCoinbase: false,
      },
    ],
  }),
  getFeeEstimate: async () => ({
    estimate: { normalBuckets: [{ feerate: 100 }] },
  }),
  submitTransaction: async () => {
    submitCalls += 1;
    throw new Error("submission must not be reached");
  },
});

const realPrepareSend = wallet.prepareSend.bind(wallet);
wallet.prepareSend = async (...args) => {
  prepareCalls += 1;
  try {
    return await realPrepareSend(...args);
  } catch (error) {
    preparationErrors.push(String(error?.message ?? error));
    throw error;
  }
};

const inert = (kind) => ({
  kind,
  async prepare() {
    throw new Error("unused adapter");
  },
  async submit() {
    throw new Error("unused adapter");
  },
  async observe() {
    throw new Error("unused adapter");
  },
  async commit() {
    throw new Error("unused adapter");
  },
});
const adapters = [
  new WalletTreasuryOperationAdapter(wallet),
  inert("vault_send"),
  inert("vault_deposit"),
];
const journalPath = path.join(directory, "purchase.sqlite");
let journal;

function newModule() {
  return new TreasuryOperationModule({
    journal,
    policy,
    adapters,
    feeCeilingAtomic: "10",
  });
}

function captureTools(module) {
  const tools = new Map();
  const runtime = {
    wallet,
    vault: { configured: false },
    journal,
    purchase: {
      async purchase() {
        throw new Error("unused Purchase module");
      },
      status() {
        throw new Error("unused Purchase module");
      },
      async recover() {
        throw new Error("unused Purchase module");
      },
    },
  };
  registerSompiTools(
    {
      registerTool(name, config, handler) {
        tools.set(name, { config, handler });
      },
    },
    runtime,
    module,
  );
  return tools;
}

async function invoke(tools, name, input) {
  const tool = tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  const parsed = {};
  for (const [field, schema] of Object.entries(tool.config.inputSchema ?? {})) {
    const result = schema.safeParse(input[field]);
    assert.equal(result.success, true, `${name}.${field} must pass the MCP schema`);
    if (result.data !== undefined) parsed[field] = result.data;
  }
  return tool.handler(parsed);
}

function responseCode(response) {
  return JSON.parse(response.content[0].text).errorCode;
}

try {
  journal = new PurchaseJournal(journalPath, { now: () => 1_900_000_000_000 });
  let module = newModule();
  let tools = captureTools(module);

  const first = await invoke(tools, "send_payment", {
    operationKey: "poc:can-031",
    to: destination,
    amountSompi: "100",
  });
  assert.equal(first.isError, true);
  assert.equal(responseCode(first), "WALLET_SEND_FAILED");
  assert.match(preparationErrors[0], /address payload is invalid/i);
  assert.equal(module.status("poc:can-031").state, "intent");
  assert.equal(module.unresolvedCount(), 1);
  assert.equal(module.effectiveCapacityUsed(), 110n);
  assert.equal(submitCalls, 0);

  const second = await invoke(tools, "send_payment", {
    operationKey: "poc:blocked-second",
    to: destination,
    amountSompi: "1",
  });
  assert.equal(second.isError, true);
  let secondOperationBlockReason = "";
  try {
    await module.execute({
      operationKey: "poc:blocked-detail",
      kind: "wallet_send",
      destination,
      amountAtomic: "1",
    });
  } catch (error) {
    secondOperationBlockReason = String(error?.message ?? error);
  }
  assert.match(secondOperationBlockReason, /another direct Treasury operation is unresolved/);

  journal.close();
  journal = new PurchaseJournal(journalPath, { now: () => 1_900_000_000_000 });
  module = newModule();
  tools = captureTools(module);
  const recovery = await invoke(tools, "treasury_operation_recover", {
    operationKey: "poc:can-031",
  });
  assert.equal(recovery.isError, true);
  assert.equal(responseCode(recovery), "TREASURY_OPERATION_RECOVERY_FAILED");
  assert.match(preparationErrors[1], /address payload is invalid/i);
  assert.equal(module.status("poc:can-031").state, "intent");
  assert.equal(module.unresolvedCount(), 1);
  assert.equal(module.effectiveCapacityUsed(), 110n);
  assert.equal(prepareCalls, 2);
  assert.equal(submitCalls, 0);

  console.log(
    JSON.stringify({
      mcpTransport: "stdio",
      mcpSchemaAcceptedDestination: true,
      firstResponseCode: responseCode(first),
      preparationError: preparationErrors[0],
      stateAfterFailure: module.status("poc:can-031").state,
      unresolvedAfterRestart: module.unresolvedCount(),
      reservedCapacityAfterRestart: module.effectiveCapacityUsed().toString(),
      secondResponseCode: responseCode(second),
      secondOperationBlockReason,
      recoveryResponseCode: responseCode(recovery),
      prepareCalls,
      submitCalls,
      irreversibleSideEffectReached: submitCalls > 0,
    }),
  );
} finally {
  journal?.close();
  sourceScript.free();
  fs.rmSync(directory, { recursive: true, force: true });
}
