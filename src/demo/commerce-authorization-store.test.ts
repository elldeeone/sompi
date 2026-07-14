import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DemoCommerceAuthorizationStoreError,
  SqliteDemoCommerceAuthorizationStore,
} from "./commerce-authorization-store.js";

test("commerce authorization store rejects hard-linked and permissive database files", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "sompi-demo-commerce-store-")
  );
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "authorization.sqlite");
  const store = new SqliteDemoCommerceAuthorizationStore(filename);
  store.close();
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);

  const alias = path.join(directory, "authorization-alias.sqlite");
  fs.linkSync(filename, alias);
  assert.throws(
    () => new SqliteDemoCommerceAuthorizationStore(filename),
    DemoCommerceAuthorizationStoreError
  );
  fs.unlinkSync(alias);
  fs.chmodSync(filename, 0o644);
  assert.throws(
    () => new SqliteDemoCommerceAuthorizationStore(filename),
    DemoCommerceAuthorizationStoreError
  );
  fs.rmSync(directory, { recursive: true, force: true });
});
