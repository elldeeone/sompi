import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  SompiRuntimeConfigError,
  assertSompiPurchaseRuntimeConfig,
  purchaseRuntimeConfigFromEnv,
  secureRuntimeDirectory,
} from "./config.js";

test("runtime environment parsing canonicalizes only explicit bounded values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-runtime-config-"));
  try {
    const policy = path.join(root, "policy.json");
    fs.writeFileSync(policy, "{}\n", { mode: 0o600 });
    const config = purchaseRuntimeConfigFromEnv(
      {
        ...baseEnvironment(),
        SOMPI_DATA_DIR: path.join(root, "data"),
        SOMPI_AUTHORITY_ROOT_DIR: path.join(root, "authority"),
        SOMPI_EGRESS_ALLOW: JSON.stringify([
          { hostname: "Merchant.Example.", ports: [8443, 443] },
          { hostname: "2001:4860:4860::8888", ports: [443] },
        ]),
        SOMPI_EGRESS_PROTOCOLS: JSON.stringify(["https:", "http:"]),
        SOMPI_NODE_URL: "wss://node.example/ws",
        SOMPI_POLICY: policy,
        SOMPI_TREASURY_OPERATION_FEE_CEILING: "123456",
      },
      root
    );

    assert.equal(config.networkId, "testnet-10");
    assert.equal(config.x402Network, "kaspa:testnet-10");
    assert.equal(config.egressAllowRules[0].hostname, "merchant.example");
    assert.deepEqual(config.egressAllowRules[0].ports, [443, 8443]);
    assert.equal(config.egressAllowRules[1].hostname, "2001:4860:4860::8888");
    assert.deepEqual(config.egressProtocols, ["https:", "http:"]);
    assert.equal(config.nodeUrl, "wss://node.example/ws");
    assert.equal(config.policyPath, policy);
    assert.equal(config.treasuryOperationFeeCeilingAtomic, "123456");
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.authority), true);
    assert.equal(Object.isFrozen(config.authority.socketAccess), true);
    assert.deepEqual(Object.keys(config.authority.paths).sort(), [
      "directory",
      "macKey",
      "socket",
      "trust",
    ]);
    assert.equal(JSON.stringify(config.authority).includes("privateJwk"), false);
    assert.equal(
      config.authority.paths.directory,
      path.join(root, "authority", "client"),
    );
    assert.equal(Object.isFrozen(config.egressAllowRules), true);
    assert.equal(fs.statSync(config.dataDirectory).mode & 0o777, 0o700);
    assert.doesNotThrow(() => assertSompiPurchaseRuntimeConfig(config));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid environment fails before creating or chmodding runtime state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-runtime-config-invalid-"));
  try {
    const cases: Array<Readonly<Record<string, string | undefined>>> = [
      { SOMPI_AP2_MERCHANT_RECEIPT_ISSUER: undefined },
      { SOMPI_AP2_PAYMENT_RECEIPT_ISSUER: " receipt:payment" },
      {
        SOMPI_AP2_MERCHANT_RECEIPT_ISSUER: "receipt:shared",
        SOMPI_AP2_PAYMENT_RECEIPT_ISSUER: "receipt:shared",
      },
      { SOMPI_DATA_DIR: "" },
      { SOMPI_AUTHORITY_CLIENT_DIR: " " },
      { SOMPI_AUTHORITY_RUNTIME_DIR: "" },
      { SOMPI_AUTHORITY_SOCKET: "relative.sock" },
      { SOMPI_AUTHORITY_SOCKET_UID: "1000", SOMPI_AUTHORITY_SOCKET_GID: undefined },
      { SOMPI_AUTHORITY_SOCKET_UID: undefined, SOMPI_AUTHORITY_SOCKET_GID: "1000" },
      { SOMPI_AUTHORITY_SOCKET_UID: "-1", SOMPI_AUTHORITY_SOCKET_GID: "1000" },
      { SOMPI_POLICY: "" },
      { SOMPI_AUTHORITY_IPC_KEY_ID: "invalid/key" },
      { SOMPI_PURCHASE_ADDITIONAL_COST_CEILING: "01" },
      { SOMPI_TREASURY_OPERATION_FEE_CEILING: "0" },
      { SOMPI_EGRESS_ALLOW: "not-json" },
      {
        SOMPI_EGRESS_ALLOW: JSON.stringify([
          { hostname: "merchant.example", ports: [443, 443] },
        ]),
      },
      {
        SOMPI_EGRESS_ALLOW: JSON.stringify([
          { hostname: "merchant.example", ports: [443] },
          { hostname: "MERCHANT.EXAMPLE.", ports: [8443] },
        ]),
      },
      {
        SOMPI_EGRESS_ALLOW: JSON.stringify([
          { hostname: "-merchant.example", ports: [443] },
        ]),
      },
      { SOMPI_EGRESS_PROTOCOLS: JSON.stringify(["https:", "https:"]) },
      { SOMPI_NODE_URL: "wss://node.example/ws?token=secret" },
    ];

    for (const [index, overrides] of cases.entries()) {
      const home = path.join(root, `home-${index}`);
      const env = { ...baseEnvironment(), ...overrides };
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete env[key];
      }
      assert.throws(
        () => purchaseRuntimeConfigFromEnv(env, home),
        SompiRuntimeConfigError,
        `case ${index}`
      );
      assert.equal(
        fs.existsSync(path.join(home, ".sompi", "testnet-10")),
        false,
        `case ${index} created state`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("programmatic runtime configuration rejects path escape and unknown fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-runtime-config-object-"));
  try {
    const config = purchaseRuntimeConfigFromEnv(
      {
        ...baseEnvironment(),
        SOMPI_DATA_DIR: path.join(root, "data"),
        SOMPI_AUTHORITY_ROOT_DIR: path.join(root, "authority"),
      },
      root
    );
    assert.throws(
      () =>
        assertSompiPurchaseRuntimeConfig({
          ...config,
          journalDatabase: path.join(root, "escaped.sqlite"),
        }),
      /not bound/
    );
    assert.throws(
      () =>
        assertSompiPurchaseRuntimeConfig({
          ...config,
          unexpected: true,
        }),
      /unknown or missing fields/
    );
    assert.throws(
      () =>
        assertSompiPurchaseRuntimeConfig({
          ...config,
          paymentReceiptIssuer: config.merchantReceiptIssuer,
        }),
      /must be distinct/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("secure runtime directory rejects a symbolic-link target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-runtime-config-link-"));
  try {
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link, "dir");
    assert.throws(() => secureRuntimeDirectory(link), SompiRuntimeConfigError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    SOMPI_AUTHORITY_SOCKET_UID: String(
      Math.min((typeof process.getuid === "function" ? process.getuid() : 1000) + 1, 0x7fffffff)
    ),
    SOMPI_AUTHORITY_SOCKET_GID: String(
      typeof process.getgid === "function" ? process.getgid() : 1000
    ),
    SOMPI_AP2_MERCHANT_RECEIPT_ISSUER: "receipt:merchant",
    SOMPI_AP2_PAYMENT_RECEIPT_ISSUER: "receipt:payment",
    SOMPI_EGRESS_ALLOW: JSON.stringify([
      { hostname: "merchant.example", ports: [443] },
    ]),
  };
}
