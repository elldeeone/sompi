#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const fixturesPath = path.join(repoRoot, "scripts", "escrow-fixtures.json");
const contractPath = path.join(repoRoot, "contracts", "escrow.sil");
const checkOnly = process.argv.includes("--check");

function hexToBytesExpr(hex, name) {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${name} must be even-length hex`);
  }
  return {
    kind: "array",
    data: Array.from(Buffer.from(hex, "hex"), (byte) => ({ kind: "byte", data: byte })),
  };
}

function networkHash(network) {
  return crypto.createHash("sha256").update(network).digest("hex");
}

function silvercInvocation() {
  if (process.env.SILVERC) {
    return { command: process.env.SILVERC, prefix: [], cwd: repoRoot };
  }
  if (process.env.SILVERSCRIPT_DIR) {
    return {
      command: "cargo",
      prefix: ["run", "--quiet", "-p", "silverscript-lang", "--bin", "silverc", "--"],
      cwd: process.env.SILVERSCRIPT_DIR,
    };
  }
  return { command: "silverc", prefix: [], cwd: repoRoot };
}

function compileFixture(fixture, index, tempDir, invocation) {
  const network = fixture.network ?? "testnet-10";
  const timeout = Number(fixture.timeout);
  if (!Number.isSafeInteger(timeout) || timeout < 0) {
    throw new Error(`fixture ${index} timeout must be a non-negative safe integer`);
  }
  const args = [
    hexToBytesExpr(fixture.client, `fixture ${index} client`),
    hexToBytesExpr(fixture.server, `fixture ${index} server`),
    hexToBytesExpr(networkHash(network), `fixture ${index} network hash`),
    { kind: "int", data: timeout },
  ];
  const argsPath = path.join(tempDir, `escrow-args-${index}.json`);
  const outPath = path.join(tempDir, `escrow-compiled-${index}.json`);
  fs.writeFileSync(argsPath, JSON.stringify(args));

  const result = spawnSync(
    invocation.command,
    [...invocation.prefix, contractPath, "--constructor-args", argsPath, "-o", outPath],
    { cwd: invocation.cwd, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `silverc failed for fixture ${index}\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
    );
  }
  const compiled = JSON.parse(fs.readFileSync(outPath, "utf8"));
  if (compiled.contract_name !== "SompiEscrow") {
    throw new Error(`fixture ${index} compiled unexpected contract ${compiled.contract_name}`);
  }
  return Buffer.from(compiled.script).toString("hex");
}

function main() {
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-fixtures-"));
  const invocation = silvercInvocation();
  try {
    const updated = fixtures.map((fixture, index) => ({
      ...fixture,
      redeemScript: compileFixture(fixture, index, tempDir, invocation),
    }));
    const next = `${JSON.stringify(updated, null, 2)}\n`;
    const current = fs.readFileSync(fixturesPath, "utf8");
    if (checkOnly) {
      if (next !== current) {
        console.error("escrow fixtures differ from SilverScript compiler output");
        process.exit(1);
      }
      console.log(`escrow fixtures match SilverScript compiler output (${fixtures.length}/${fixtures.length})`);
      return;
    }
    fs.writeFileSync(fixturesPath, next);
    console.log(`wrote ${fixtures.length} compiler-derived escrow fixtures to ${path.relative(repoRoot, fixturesPath)}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
