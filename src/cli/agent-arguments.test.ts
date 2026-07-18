import assert from "node:assert/strict";
import test from "node:test";

import { AgentCliArgumentError, parseAgentArguments } from "./agent-arguments.js";

test("agent CLI parses the direct Purchase API commands", () => {
  assert.deepEqual(parseAgentArguments(["status", "pur_AAAAAAAAAAAAAAAAAAAAAA"]), {
    kind: "status",
    purchaseId: "pur_AAAAAAAAAAAAAAAAAAAAAA",
  });
  assert.deepEqual(parseAgentArguments(["recover", "pur_AAAAAAAAAAAAAAAAAAAAAA"]), {
    kind: "recover",
    purchaseId: "pur_AAAAAAAAAAAAAAAAAAAAAA",
  });
  assert.deepEqual(parseAgentArguments([
    "purchase",
    "--request-key", "task-123-resource-1",
    "--url", "https://merchant.example/resource",
    "--method", "POST",
    "--media-type", "application/json",
    "--body-file", "/tmp/request.json",
    "--merchant-id", "merchant:test",
    "--merchant-origin", "https://merchant.example",
  ]), {
    kind: "purchase",
    requestKey: "task-123-resource-1",
    url: "https://merchant.example/resource",
    method: "POST",
    mediaType: "application/json",
    bodyFile: "/tmp/request.json",
    merchantId: "merchant:test",
    merchantOrigin: "https://merchant.example",
  });
});

test("agent CLI rejects ambiguous or secret-prone argument forms", () => {
  for (const args of [
    [] as string[],
    ["purchase", "--url", "https://merchant.example"],
    ["purchase", "--request-key=x", "--url", "https://merchant.example"],
    ["purchase", "--request-key", "x", "--url", "https://merchant.example", "--request-key", "y"],
    ["purchase", "--request-key", "x", "--url", "https://merchant.example", "--body-file", "relative"],
    ["status"],
  ]) {
    assert.throws(() => parseAgentArguments(args), AgentCliArgumentError);
  }
});
