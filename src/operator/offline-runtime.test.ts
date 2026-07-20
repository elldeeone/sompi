import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { OfflineRuntimeIdentityError, dropToRuntimeIdentity } from "./offline-runtime.js";

test("offline owner execution validates runtime ownership before dropping permanently", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-offline-runtime-"));
  try {
    fs.chmodSync(directory, 0o700);
    let stat = fs.statSync(directory);
    if (stat.uid === 0) {
      fs.chownSync(directory, 1, stat.gid);
      stat = fs.statSync(directory);
    }
    const calls: Array<readonly [string, unknown]> = [];
    let uid = 0;
    let gid = 0;
    dropToRuntimeIdentity({
      operatorUserId: 0,
      runtimeUserId: stat.uid,
      runtimeGroupId: 1000,
      authorityGroupId: 1001,
      dataDirectory: directory,
    }, {
      getuid: () => uid,
      getgid: () => gid,
      setgroups(groups) { calls.push(["groups", [...groups]]); },
      setgid(value) { calls.push(["gid", value]); gid = value; },
      setuid(value) { calls.push(["uid", value]); uid = value; },
    });
    assert.deepEqual(calls, [
      ["groups", [...new Set([stat.gid, 1000, 1001])]],
      ["gid", stat.gid],
      ["uid", stat.uid],
    ]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("offline owner execution rejects non-root operators and unsafe runtime paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-offline-runtime-reject-"));
  const link = `${directory}-link`;
  try {
    fs.chmodSync(directory, 0o700);
    fs.symlinkSync(directory, link, "dir");
    const inert = {
      getuid: () => 1,
      getgid: () => 1,
      setgroups() { assert.fail("identity must not change"); },
      setgid() { assert.fail("identity must not change"); },
      setuid() { assert.fail("identity must not change"); },
    };
    assert.throws(() => dropToRuntimeIdentity({
      operatorUserId: 0, runtimeUserId: 1, runtimeGroupId: 2,
      authorityGroupId: 3, dataDirectory: directory,
    }, inert), /begin as the declared root operator/);
    assert.throws(() => dropToRuntimeIdentity({
      operatorUserId: 0, runtimeUserId: 1, runtimeGroupId: 2,
      authorityGroupId: 3, dataDirectory: link,
    }, { ...inert, getuid: () => 0 }), OfflineRuntimeIdentityError);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
