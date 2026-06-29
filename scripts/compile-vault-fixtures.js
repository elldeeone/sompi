#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const fixturesPath = path.join(repoRoot, "scripts", "vault-fixtures.json");
const contractPath = path.join(repoRoot, "contracts", "vault.sil");
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

function pushDataHex(hex) {
  const byteLen = hex.length / 2;
  if (byteLen <= 75) return `${byteLen.toString(16).padStart(2, "0")}${hex}`;
  if (byteLen <= 0xff) return `4c${byteLen.toString(16).padStart(2, "0")}${hex}`;
  if (byteLen <= 0xffff) {
    return `4d${(byteLen & 0xff).toString(16).padStart(2, "0")}${(byteLen >> 8).toString(16).padStart(2, "0")}${hex}`;
  }
  throw new Error("dummy argument too large");
}

function pushNumberHex(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error("negative selectors are not supported");
  if (v === 0n) return "00";
  if (v <= 16n) return (0x50 + Number(v)).toString(16).padStart(2, "0");
  const bytes = [];
  while (v > 0n) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return pushDataHex(Buffer.from(bytes).toString("hex"));
}

function expectInputs(entry, expected) {
  if (!entry) throw new Error(`missing ${expected.name} entrypoint in compiled ABI`);
  const actual = entry.inputs ?? [];
  if (actual.length !== expected.inputs.length) {
    throw new Error(`${expected.name} ABI input count changed`);
  }
  for (let i = 0; i < expected.inputs.length; i++) {
    const want = expected.inputs[i];
    const got = actual[i];
    if (got?.name !== want.name || got?.type_name !== want.type_name) {
      throw new Error(
        `${expected.name} ABI input ${i} changed: expected ${want.name}:${want.type_name}, ` +
          `got ${got?.name ?? "missing"}:${got?.type_name ?? "missing"}`
      );
    }
  }
}

function entrySelectorHex(compiled, entryName) {
  if (compiled.without_selector) return "";
  const index = compiled.abi.findIndex((entry) => entry.name === entryName);
  if (index < 0) throw new Error(`missing ${entryName} entrypoint in compiled ABI`);
  return pushNumberHex(index);
}

function assertVaultAbi(compiled) {
  if (compiled.contract_name !== "SompiVault") {
    throw new Error(`compiled unexpected contract ${compiled.contract_name}`);
  }
  if (compiled.without_selector) {
    throw new Error("SompiVault must keep explicit entrypoint selectors");
  }
  if (compiled.state_layout?.start !== 1 || compiled.state_layout?.len !== 18) {
    throw new Error(`SompiVault state layout drifted: ${JSON.stringify(compiled.state_layout)}`);
  }

  expectInputs(compiled.abi.find((entry) => entry.name === "withdraw"), {
    name: "withdraw",
    inputs: [{ name: "agentSig", type_name: "sig" }],
  });
  expectInputs(compiled.abi.find((entry) => entry.name === "topup"), {
    name: "topup",
    inputs: [{ name: "agentSig", type_name: "sig" }],
  });
  expectInputs(compiled.abi.find((entry) => entry.name === "recover"), {
    name: "recover",
    inputs: [{ name: "ownerSig", type_name: "sig" }],
  });

  const selectors = ["withdraw", "topup", "recover"].map((name) => entrySelectorHex(compiled, name));
  if (selectors.join(",") !== "00,51,52") {
    throw new Error(`SompiVault selector drift: ${selectors.join(",")}`);
  }
}

function dummyArgsHex(compiled, entryName) {
  return `${pushDataHex("ab".repeat(65))}${entrySelectorHex(compiled, entryName)}`;
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

function intArg(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return { kind: "int", data: n };
}

function compileFixture(fixture, index, tempDir, invocation) {
  const args = [
    hexToBytesExpr(fixture.agent, `fixture ${index} agent`),
    hexToBytesExpr(fixture.owner, `fixture ${index} owner`),
    intArg(fixture.maxOutflow, `fixture ${index} maxOutflow`),
    intArg(fixture.windowSize, `fixture ${index} windowSize`),
    intArg(fixture.windowStart, `fixture ${index} windowStart`),
    intArg(fixture.spentInWindow, `fixture ${index} spentInWindow`),
  ];
  const argsPath = path.join(tempDir, `vault-args-${index}.json`);
  const outPath = path.join(tempDir, `vault-compiled-${index}.json`);
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
  assertVaultAbi(compiled);
  return {
    redeemScript: Buffer.from(compiled.script).toString("hex"),
    withdrawArgsWithDummySig: dummyArgsHex(compiled, "withdraw"),
    topupArgsWithDummySig: dummyArgsHex(compiled, "topup"),
    recoverArgsWithDummySig: dummyArgsHex(compiled, "recover"),
  };
}

function main() {
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-fixtures-"));
  const invocation = silvercInvocation();
  try {
    const updated = fixtures.map((fixture, index) => ({
      ...fixture,
      ...compileFixture(fixture, index, tempDir, invocation),
    }));
    const next = `${JSON.stringify(updated, null, 2)}\n`;
    const current = fs.readFileSync(fixturesPath, "utf8");
    if (checkOnly) {
      if (next !== current) {
        console.error("vault fixtures differ from SilverScript compiler output");
        process.exit(1);
      }
      console.log(`vault fixtures match SilverScript compiler output (${fixtures.length}/${fixtures.length})`);
      return;
    }
    fs.writeFileSync(fixturesPath, next);
    console.log(`wrote ${fixtures.length} compiler-derived vault fixtures to ${path.relative(repoRoot, fixturesPath)}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
