import assert from "node:assert/strict";
import test from "node:test";

import { canonicalEvidenceJson } from "./canonical-json.js";

test("canonical evidence JSON is key-order independent and strict", () => {
  assert.equal(
    canonicalEvidenceJson({ z: [3, { y: true, a: null }], a: -0 }),
    '{"a":0,"z":[3,{"a":null,"y":true}]}'
  );
  assert.equal(
    canonicalEvidenceJson({ a: 1, z: 2 }),
    canonicalEvidenceJson({ z: 2, a: 1 })
  );
  assert.throws(() => canonicalEvidenceJson({ missing: undefined }), /not JSON-serializable/);
  assert.throws(() => canonicalEvidenceJson(new Array(1)), /not JSON-serializable/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalEvidenceJson(cyclic), /cyclic JSON value/);
});
