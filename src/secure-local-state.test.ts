import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  SecureLocalStateDirectory,
} from "./secure-local-state.js";

test("secure local state publishes no-clobber files and atomically replaces bounded state", () => {
  const root = temporaryDirectory("sompi-secure-state-");
  try {
    const state = new SecureLocalStateDirectory(path.join(root, "state"), "test state");
    assert.equal(fs.statSync(state.directory).mode & 0o777, 0o700);

    state.createFileExclusive("secret", Buffer.from("first"), 64);
    const filename = path.join(state.directory, "secret");
    assert.equal(state.readFile("secret", 64).toString("utf8"), "first");
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(filename).nlink, 1);
    assert.throws(
      () => state.createFileExclusive("secret", Buffer.from("second"), 64),
      /already exists/
    );
    assert.equal(state.readFile("secret", 64).toString("utf8"), "first");

    state.replaceFileAtomic("secret", Buffer.from("second"), 64);
    assert.equal(state.readFile("secret", 64).toString("utf8"), "second");
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(filename).nlink, 1);
    assert.throws(() => state.readFile("secret", 3), /size is invalid/);
    state.removeFile("secret");
    assert.equal(state.fileExists("secret"), false);

    state.createEmptyFileExclusive("empty.sqlite");
    const empty = path.join(state.directory, "empty.sqlite");
    assert.equal(fs.statSync(empty).size, 0);
    assert.equal(fs.statSync(empty).mode & 0o777, 0o600);
    assert.equal(fs.statSync(empty).nlink, 1);
    assert.throws(() => state.createEmptyFileExclusive("empty.sqlite"), /already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("secure local state rejects symlinks, hard links, unsafe modes, and replaced directories", () => {
  const root = temporaryDirectory("sompi-secure-adversarial-");
  try {
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "outside", { mode: 0o600 });

    const linkedDirectory = path.join(root, "linked-state");
    fs.symlinkSync(root, linkedDirectory, "dir");
    assert.throws(
      () => new SecureLocalStateDirectory(linkedDirectory, "linked state"),
      /real directory|symbolic link/
    );

    const realParent = path.join(root, "real-parent");
    fs.mkdirSync(realParent, { mode: 0o700 });
    const linkedParent = path.join(root, "linked-parent");
    fs.symlinkSync(realParent, linkedParent, "dir");
    assert.throws(
      () => new SecureLocalStateDirectory(path.join(linkedParent, "nested"), "nested state"),
      /must not contain symbolic links|canonical real path/
    );
    assert.equal(
      fs.existsSync(path.join(realParent, "nested")),
      false,
      "symlink components must be rejected before creating state in their target"
    );

    const looseDirectory = path.join(root, "loose-state");
    fs.mkdirSync(looseDirectory, { mode: 0o755 });
    fs.chmodSync(looseDirectory, 0o755);
    assert.throws(
      () => new SecureLocalStateDirectory(looseDirectory, "loose state"),
      /permissions must be 0700/
    );

    const state = new SecureLocalStateDirectory(path.join(root, "state"), "test state");
    const target = path.join(state.directory, "value");
    fs.symlinkSync(outside, target);
    assert.throws(() => state.fileExists("value"), /regular file/);
    fs.unlinkSync(target);

    fs.writeFileSync(target, "value", { mode: 0o600 });
    const alias = path.join(root, "alias");
    fs.linkSync(target, alias);
    assert.throws(() => state.readFile("value", 64), /exactly one filesystem link/);
    fs.unlinkSync(alias);

    fs.chmodSync(target, 0o640);
    assert.throws(() => state.readFile("value", 64), /permissions must be 0600/);
    fs.chmodSync(target, 0o600);

    const moved = path.join(root, "moved-state");
    fs.renameSync(state.directory, moved);
    fs.mkdirSync(state.directory, { mode: 0o700 });
    assert.throws(() => state.fileExists("value"), /directory identity changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("secure local state repairs only its own interrupted publication names", () => {
  const root = temporaryDirectory("sompi-secure-repair-");
  try {
    const state = new SecureLocalStateDirectory(path.join(root, "state"), "test state");
    const target = path.join(state.directory, "secret");
    fs.writeFileSync(target, "complete", { mode: 0o600 });
    const linkedTemporary = path.join(
      state.directory,
      `.secret.create-123-${"a".repeat(32)}.tmp`
    );
    fs.linkSync(target, linkedTemporary);
    assert.equal(fs.statSync(target).nlink, 2);
    assert.equal(state.fileExists("secret"), true);
    assert.equal(fs.existsSync(linkedTemporary), false);
    assert.equal(fs.statSync(target).nlink, 1);

    const interruptedReplacement = path.join(
      state.directory,
      `.secret.replace-123-${"b".repeat(32)}.tmp`
    );
    fs.writeFileSync(interruptedReplacement, "{", { mode: 0o600 });
    assert.equal(state.readFile("secret", 64).toString("utf8"), "complete");
    assert.equal(fs.existsSync(interruptedReplacement), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic local-state replacement remains parseable across an abrupt process kill", async () => {
  const root = temporaryDirectory("sompi-secure-crash-");
  try {
    const directory = path.join(root, "state");
    const state = new SecureLocalStateDirectory(directory, "crash state");
    state.createFileExclusive("config.json", Buffer.from('{"generation":0}\n'), 1024);

    const moduleUrl = pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "secure-local-state.js")
    ).href;
    const source = `
      const { SecureLocalStateDirectory } = await import(process.argv[1]);
      const state = new SecureLocalStateDirectory(process.argv[2], "crash state");
      process.stdout.write("ready\\n");
      for (let generation = 1; ; generation++) {
        const bytes = Buffer.from(JSON.stringify({ generation, padding: "x".repeat(4096) }) + "\\n");
        state.replaceFileAtomic("config.json", bytes, 8192);
      }
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", source, moduleUrl, directory],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    await waitForReady(child);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await exited;

    const restarted = new SecureLocalStateDirectory(directory, "crash state");
    const bytes = restarted.readFile("config.json", 8192);
    try {
      const value = JSON.parse(bytes.toString("utf8")) as { generation?: unknown };
      assert.equal(Number.isSafeInteger(value.generation), true);
      if (typeof value.generation !== "number") throw new Error("generation is not numeric");
      assert.ok(value.generation >= 0);
      assert.equal(fs.statSync(path.join(directory, "config.json")).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(directory, "config.json")).nlink, 1);
    } finally {
      bytes.fill(0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("secure local state rejects a file owned by another uid when privileged", (t) => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    t.skip("changing file ownership requires root");
    return;
  }
  const root = temporaryDirectory("sompi-secure-owner-");
  try {
    const state = new SecureLocalStateDirectory(path.join(root, "state"), "owner state");
    const filename = path.join(state.directory, "secret");
    fs.writeFileSync(filename, "secret", { mode: 0o600 });
    fs.chownSync(filename, 65534, 65534);
    assert.throws(() => state.readFile("secret", 64), /owned by the current user/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`crash-test child did not become ready: ${stderr}`));
    }, 5_000);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      if (!String(chunk).includes("ready")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`crash-test child exited early (${code ?? signal}): ${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
