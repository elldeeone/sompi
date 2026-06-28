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

function assertEscrowAbi(compiled) {
  if (compiled.contract_name !== "SompiEscrow") {
    throw new Error(`compiled unexpected contract ${compiled.contract_name}`);
  }
  if (compiled.without_selector) {
    throw new Error("SompiEscrow must keep explicit entrypoint selectors");
  }

  const claim = compiled.abi.find((entry) => entry.name === "claim");
  const refund = compiled.abi.find((entry) => entry.name === "refund");
  expectInputs(claim, {
    name: "claim",
    inputs: [
      { name: "serverSig", type_name: "sig" },
      { name: "clientVoucher", type_name: "datasig" },
      { name: "amountAuthorized", type_name: "byte[8]" },
    ],
  });
  expectInputs(refund, {
    name: "refund",
    inputs: [{ name: "clientSig", type_name: "sig" }],
  });

  const claimSelector = entrySelectorHex(compiled, "claim");
  const refundSelector = entrySelectorHex(compiled, "refund");
  if (claimSelector !== "00" || refundSelector !== "51") {
    throw new Error(`SompiEscrow selector drift: claim=${claimSelector}, refund=${refundSelector}`);
  }
}

function dummyArgFor(input) {
  if (input.type_name === "sig" && input.name === "serverSig") return "ab".repeat(65);
  if (input.type_name === "sig" && input.name === "clientSig") return "ab".repeat(65);
  if (input.type_name === "datasig" && input.name === "clientVoucher") return "cd".repeat(64);
  if (input.type_name === "byte[8]" && input.name === "amountAuthorized") return "ef".repeat(8);
  throw new Error(`no dummy argument fixture for ${input.name}:${input.type_name}`);
}

function dummyArgsHex(compiled, entryName) {
  const entry = compiled.abi.find((item) => item.name === entryName);
  if (!entry) throw new Error(`missing ${entryName} entrypoint in compiled ABI`);
  return `${entry.inputs.map((input) => pushDataHex(dummyArgFor(input))).join("")}${entrySelectorHex(compiled, entryName)}`;
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
  assertEscrowAbi(compiled);
  return {
    redeemScript: Buffer.from(compiled.script).toString("hex"),
    claimArgsWithDummies: dummyArgsHex(compiled, "claim"),
    refundArgsWithDummySig: dummyArgsHex(compiled, "refund"),
  };
}

function main() {
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-escrow-fixtures-"));
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
