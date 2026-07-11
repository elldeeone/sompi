#!/usr/bin/env node
"use strict";

/**
 * Root-only deployment check for the sompi-authority / sompi-mcp OS boundary.
 * It prints metadata and pass/fail facts only; credential contents are never read.
 * Run it only while sompi-authority is listening: its connect probe sends no
 * frame and cannot request an approval.
 *
 * Usage:
 *   node scripts/verify-authority-isolation.js \
 *     --authority-user sompi-authority --mcp-user sompi-mcp \
 *     --ipc-group sompi-ipc \
 *     --private-dir /var/lib/sompi-authority/private \
 *     --client-dir /var/lib/sompi-mcp-authority-client \
 *     --runtime-dir /run/sompi-authority \
 *     --socket /run/sompi-authority/authority.sock
 */

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REQUIRED = Object.freeze([
  "authority-user",
  "mcp-user",
  "ipc-group",
  "private-dir",
  "client-dir",
  "runtime-dir",
  "socket",
]);

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("this access check must run as root so it can probe both service users");
  }
  const authority = identity(options["authority-user"]);
  const mcp = identity(options["mcp-user"]);
  const group = groupIdentity(options["ipc-group"]);
  if (authority.uid === 0 || mcp.uid === 0 || authority.uid === mcp.uid) {
    fail("authority and MCP must be distinct non-root OS users");
  }
  if (!supplementaryGroups(authority.name).includes(group.gid)) {
    fail("authority user is not a member of the configured IPC group");
  }
  if (!supplementaryGroups(mcp.name).includes(group.gid)) {
    fail("MCP user is not a member of the configured IPC group");
  }

  const privateDirectory = canonicalExistingPath(
    options["private-dir"],
    "private directory"
  );
  const clientDirectory = canonicalExistingPath(
    options["client-dir"],
    "client directory"
  );
  const runtimeDirectory = canonicalExistingPath(
    options["runtime-dir"],
    "runtime directory"
  );
  const socket = canonicalExistingPath(options.socket, "authority socket");
  assertDisjoint(privateDirectory, clientDirectory, runtimeDirectory);
  if (path.dirname(socket) !== runtimeDirectory) {
    fail("authority socket must be directly inside the runtime directory");
  }

  const privateJwk = path.join(privateDirectory, "authority-private.jwk.json");
  const serverMac = path.join(privateDirectory, "ipc-mac.key");
  const serverTrust = path.join(privateDirectory, "trust.json");
  const replayDatabase = path.join(privateDirectory, "replay.sqlite");
  const decisionDatabase = path.join(privateDirectory, "decisions.sqlite");
  const clientMac = path.join(clientDirectory, "ipc-mac.key");
  const clientTrust = path.join(clientDirectory, "trust.json");

  checkEntry(privateDirectory, "directory", authority.uid, authority.gid, 0o700);
  const privateFiles = [
    privateJwk,
    serverMac,
    serverTrust,
    replayDatabase,
    decisionDatabase,
  ];
  for (const filename of privateFiles) {
    checkEntry(filename, "file", authority.uid, authority.gid, 0o600);
  }
  checkPrivateDirectory(privateDirectory, authority);
  checkEntry(clientDirectory, "directory", mcp.uid, mcp.gid, 0o700);
  for (const filename of [clientMac, clientTrust]) {
    checkEntry(filename, "file", mcp.uid, mcp.gid, 0o600);
  }
  checkExactDirectoryEntries(clientDirectory, [clientMac, clientTrust]);
  assertDifferentEntries(serverMac, clientMac, "IPC MAC copies");
  assertDifferentEntries(serverTrust, clientTrust, "trust-store copies");
  checkEntry(runtimeDirectory, "directory", authority.uid, group.gid, 0o710);
  checkEntry(socket, "socket", authority.uid, group.gid, 0o660);
  checkExactDirectoryEntries(runtimeDirectory, [socket]);

  probeAccess(authority.name, "-r", true, privateJwk, "authority can read its signing key");
  probeAccess(mcp.name, "-x", false, privateDirectory, "MCP cannot traverse the authority private directory");
  probeAccess(mcp.name, "-r", false, privateJwk, "MCP cannot read the authority signing key");
  probeAccess(mcp.name, "-r", true, clientMac, "MCP can read its IPC MAC copy");
  probeAccess(mcp.name, "-r", true, clientTrust, "MCP can read its public trust store");
  probeAccess(authority.name, "-x", false, clientDirectory, "authority cannot traverse the MCP client directory");
  probeAccess(mcp.name, "-x", true, runtimeDirectory, "MCP can traverse the authority runtime directory");
  probeAccess(mcp.name, "-w", false, runtimeDirectory, "MCP cannot write the authority runtime directory");
  probeSocket(mcp.name, socket);

  process.stdout.write(`${JSON.stringify({
    status: "pass",
    authority: { user: authority.name, uid: authority.uid },
    mcp: { user: mcp.name, uid: mcp.uid },
    ipcGroup: { name: group.name, gid: group.gid },
    privateDirectory,
    clientDirectory,
    runtimeDirectory,
    socket,
    signingKeyReadableByMcp: false,
    runtimeDirectoryWritableByMcp: false,
    socketConnectableByMcp: true,
    clientFiles: ["ipc-mac.key", "trust.json"],
  }, null, 2)}\n`);
}

function parseArguments(arguments_) {
  if (arguments_.includes("--help")) usage(0);
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) usage(2);
  const options = Object.create(null);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag.startsWith("--") || !value || value.startsWith("--")) usage(2);
    const key = flag.slice(2);
    if (!REQUIRED.includes(key) || options[key] !== undefined) usage(2);
    options[key] = value;
  }
  if (REQUIRED.some((key) => options[key] === undefined)) usage(2);
  return options;
}

function usage(code) {
  process.stderr.write(
    "usage: verify-authority-isolation.js --authority-user USER --mcp-user USER " +
      "--ipc-group GROUP --private-dir PATH --client-dir PATH " +
      "--runtime-dir PATH --socket PATH\n"
  );
  process.exit(code);
}

function identity(name) {
  safeIdentityName(name, "user");
  const uid = numericCommand("id", ["-u", name], "user ID");
  const gid = numericCommand("id", ["-g", name], "primary group ID");
  return Object.freeze({ name, uid, gid });
}

function groupIdentity(name) {
  safeIdentityName(name, "group");
  const line = command("getent", ["group", name], "group lookup");
  const fields = line.split(":");
  if (fields.length !== 4 || fields[0] !== name || !/^(?:0|[1-9][0-9]{0,9})$/.test(fields[2])) {
    fail("IPC group lookup returned an invalid record");
  }
  return Object.freeze({ name, gid: Number(fields[2]) });
}

function supplementaryGroups(name) {
  return command("id", ["-G", name], "supplementary group lookup")
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => {
      if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) fail("group lookup returned an invalid ID");
      return Number(value);
    });
}

function numericCommand(program, arguments_, label) {
  const value = command(program, arguments_, label);
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) fail(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0x7fffffff) fail(`${label} is invalid`);
  return parsed;
}

function command(program, arguments_, label) {
  const result = childProcess.spawnSync(program, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") fail(`${label} failed`);
  const output = result.stdout.trim();
  if (!output || output.includes("\n")) fail(`${label} returned an invalid value`);
  return output;
}

function safeIdentityName(value, label) {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_-]{0,30}$/.test(value)) {
    fail(`${label} name is invalid`);
  }
}

function canonicalPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label} must be a canonical absolute path`);
  }
  return value;
}

function canonicalExistingPath(value, label) {
  const candidate = canonicalPath(value, label);
  let resolved;
  try {
    resolved = fs.realpathSync.native(candidate);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (resolved !== candidate) fail(`${label} must not contain symbolic-link components`);
  return candidate;
}

function assertDisjoint(...directories) {
  for (let left = 0; left < directories.length; left += 1) {
    for (let right = left + 1; right < directories.length; right += 1) {
      const a = directories[left];
      const b = directories[right];
      if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) {
        fail("authority private, MCP client, and runtime directories must be disjoint");
      }
    }
  }
}

function checkEntry(filename, kind, uid, gid, mode) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    fail(`${kind} is missing: ${filename}`);
  }
  const correctKind =
    (kind === "directory" && stat.isDirectory()) ||
    (kind === "file" && stat.isFile()) ||
    (kind === "socket" && stat.isSocket());
  if (
    !correctKind ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    stat.gid !== gid ||
    (stat.mode & 0o777) !== mode ||
    (kind !== "directory" && stat.nlink !== 1)
  ) {
    fail(`${kind} ownership or mode is invalid: ${filename}`);
  }
}

function checkPrivateDirectory(directory, owner) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    fail("authority private directory cannot be inspected");
  }
  if (entries.length === 0) fail("authority private directory is empty");
  for (const entry of entries) {
    const filename = path.join(directory, entry);
    let stat;
    try {
      stat = fs.lstatSync(filename);
    } catch {
      fail("authority private directory changed during inspection");
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== owner.uid ||
      stat.gid !== owner.gid ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1
    ) {
      fail(`authority private entry is unsafe: ${filename}`);
    }
  }
}

function checkExactDirectoryEntries(directory, expectedFiles) {
  const expected = expectedFiles.map((filename) => path.basename(filename)).sort();
  let actual;
  try {
    actual = fs.readdirSync(directory).sort();
  } catch {
    fail("isolated directory cannot be inspected");
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`isolated directory contains unexpected entries: ${directory}`);
  }
}

function assertDifferentEntries(left, right, label) {
  const a = fs.lstatSync(left);
  const b = fs.lstatSync(right);
  if (a.dev === b.dev && a.ino === b.ino) fail(`${label} must be separate files`);
}

function probeAccess(user, predicate, expected, filename, label) {
  const result = childProcess.spawnSync(
    "runuser",
    ["-u", user, "--", "test", predicate, filename],
    { stdio: "ignore" }
  );
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    fail(`${label}: effective-user probe failed`);
  }
  if ((result.status === 0) !== expected) fail(`${label}: failed`);
}

function probeSocket(user, filename) {
  const program = [
    "const net = require('node:net');",
    "const socket = net.createConnection({ path: process.argv[1] });",
    "const timer = setTimeout(() => process.exit(1), 2000);",
    "socket.once('error', () => process.exit(1));",
    "socket.once('connect', () => { clearTimeout(timer); socket.destroy(); process.exit(0); });",
  ].join("");
  const result = childProcess.spawnSync(
    "runuser",
    ["-u", user, "--", process.execPath, "-e", program, filename],
    { stdio: "ignore", timeout: 3_000, killSignal: "SIGKILL" }
  );
  if (result.status !== 0) fail("MCP cannot connect to the authority socket through the IPC group");
}

function fail(message) {
  process.stderr.write(`authority isolation check failed: ${message}\n`);
  process.exit(1);
}

try {
  main();
} catch {
  fail("unexpected local validation failure");
}
