import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  AUTHORITY_SIGNER,
  FIXED_AUTHORITY_ISSUER,
  MERCHANT_SIGNER,
} from "./test-fixtures.js";
import { loadAp2TrustStore, loadAuthoritySigningIdentity } from "./signing-key-file.js";

test("secure AP2 signing and trust files load without widening private-key access", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-ap2-files-"));
  fs.chmodSync(directory, 0o700);
  const privatePath = path.join(directory, "authority.jwk");
  const trustPath = path.join(directory, "trust.json");
  const { kty, crv, x, y, d } = AUTHORITY_SIGNER.privateJwk;
  write(privatePath, { kty, crv, x, y, d });
  const { d: _merchantPrivate, ...merchantPublic } = MERCHANT_SIGNER.privateJwk;
  const { d: _authorityPrivate, ...authorityPublic } = AUTHORITY_SIGNER.privateJwk;
  write(trustPath, [
    { role: "merchant-checkout", issuer: MERCHANT_SIGNER.issuer, kid: MERCHANT_SIGNER.kid, publicJwk: minimal(merchantPublic) },
    { role: "authority", issuer: AUTHORITY_SIGNER.issuer, kid: AUTHORITY_SIGNER.kid, publicJwk: minimal(authorityPublic) },
  ]);
  try {
    const identity = loadAuthoritySigningIdentity(privatePath, FIXED_AUTHORITY_ISSUER, AUTHORITY_SIGNER.kid);
    assert.equal(identity.privateJwk.d, d);
    const trust = loadAp2TrustStore(trustPath);
    assert(trust.resolve("authority", AUTHORITY_SIGNER.issuer, AUTHORITY_SIGNER.kid));
    assert.equal(trust.resolve("merchant-checkout", "https://attacker.example", MERCHANT_SIGNER.kid), undefined);

    fs.chmodSync(privatePath, 0o640);
    assert.throws(() => loadAuthoritySigningIdentity(privatePath, FIXED_AUTHORITY_ISSUER, AUTHORITY_SIGNER.kid), /ownership or mode/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("secure AP2 loader rejects symlinks, unknown fields, and private keys in trust entries", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-ap2-files-negative-"));
  fs.chmodSync(directory, 0o700);
  const target = path.join(directory, "target.json");
  const link = path.join(directory, "link.json");
  write(target, { ...AUTHORITY_SIGNER.privateJwk, unexpected: true });
  fs.symlinkSync(target, link);
  try {
    assert.throws(() => loadAuthoritySigningIdentity(link, FIXED_AUTHORITY_ISSUER, AUTHORITY_SIGNER.kid), /unavailable/);
    assert.throws(() => loadAuthoritySigningIdentity(target, FIXED_AUTHORITY_ISSUER, AUTHORITY_SIGNER.kid), /unknown or missing/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function write(filename: string, value: unknown): void {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function minimal(jwk: { kty: "EC"; crv: "P-256"; x: string; y: string }) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}
