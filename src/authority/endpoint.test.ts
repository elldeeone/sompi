import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  AuthorityDecisionEndpoint,
  AuthorityUnixDecisionClient,
  AuthorityUnixDecisionServer,
  decodeAuthorityDecisionEndpointResult,
  encodeAuthorityDecisionEndpointResult,
} from "./endpoint.js";

test("authority endpoint envelope is canonical, bounded, and exact", () => {
  const input = {
    responseWire: '{"wire":"authenticated"}',
    decisionEvidence: Buffer.from("signed-public-evidence"),
  };
  const wire = encodeAuthorityDecisionEndpointResult(input);
  const decoded = decodeAuthorityDecisionEndpointResult(wire);
  assert.equal(decoded.responseWire, input.responseWire);
  assert.deepEqual(Buffer.from(decoded.decisionEvidence), input.decisionEvidence);

  const parsed = JSON.parse(wire);
  assert.throws(
    () => decodeAuthorityDecisionEndpointResult(JSON.stringify({ extra: true, ...parsed })),
    /malformed/,
  );
  assert.throws(
    () => decodeAuthorityDecisionEndpointResult(JSON.stringify({
      version: parsed.version,
      profile: parsed.profile,
      responseWire: parsed.responseWire,
      decisionEvidence: parsed.decisionEvidence,
    })),
    /not canonical/,
  );
  assert.throws(
    () => decodeAuthorityDecisionEndpointResult(wire.replace(parsed.decisionEvidence, `${parsed.decisionEvidence}=`)),
    /malformed/,
  );
});

test("Unix decision endpoint carries a large public evidence artifact without widening request frames", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-authority-endpoint-"));
  const socketPath = path.join(directory, "authority.sock");
  const expected = Object.freeze({
    responseWire: '{"authenticated":"response"}',
    decisionEvidence: new Uint8Array(200 * 1024).fill(0xa7),
  });
  const endpoint = new AuthorityDecisionEndpoint({
    async handleDecision(requestWire: string) {
      assert.equal(requestWire, '{"authenticated":"request"}');
      return expected;
    },
  });
  const server = new AuthorityUnixDecisionServer({ socketPath, endpoint, timeoutMs: 2_000 });
  try {
    await server.start();
    const client = new AuthorityUnixDecisionClient({ socketPath, timeoutMs: 2_000 });
    const result = await client.request('{"authenticated":"request"}');
    assert.equal(result.responseWire, expected.responseWire);
    assert.deepEqual(result.decisionEvidence, expected.decisionEvidence);
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
