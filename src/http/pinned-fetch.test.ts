import * as assert from "node:assert/strict";
import test from "node:test";

import { EgressPolicy } from "../purchase/egress-policy.js";
import type { PinnedHttpTransport } from "./pinned-transport.js";
import { createPinnedGetFetch } from "./pinned-fetch.js";

test("witness fetch resolves once, pins the approved address, and never redirects", async () => {
  let sent = 0;
  const policy = new EgressPolicy({
    allowRules: [{ hostname: "witness.example", ports: [443] }],
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  const transport: PinnedHttpTransport = {
    async send(request) {
      sent += 1;
      assert.equal(request.hop.hostname, "witness.example");
      assert.deepEqual(request.hop.connection.addresses, [{ address: "93.184.216.34", family: 4 }]);
      return {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: (async function* () { yield Buffer.from('{"virtualDaaScore":"1"}'); })(),
      };
    },
  };
  const response = await createPinnedGetFetch(policy, transport)(
    "https://witness.example/info/blockdag",
    { method: "GET", redirect: "error" },
  );
  assert.equal(await response.text(), '{"virtualDaaScore":"1"}');
  assert.equal(sent, 1);
});

test("witness fetch rejects private DNS answers before transport", async () => {
  let sent = 0;
  const policy = new EgressPolicy({
    allowRules: [{ hostname: "witness.example", ports: [443] }],
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  const transport: PinnedHttpTransport = {
    async send() { sent += 1; throw new Error("must not send"); },
  };
  await assert.rejects(
    createPinnedGetFetch(policy, transport)("https://witness.example/", { redirect: "error" }),
    /unsafe|loopback/,
  );
  assert.equal(sent, 0);
});
