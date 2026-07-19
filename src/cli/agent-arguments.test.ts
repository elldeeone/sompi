import assert from "node:assert/strict";
import test from "node:test";

import { AgentCliArgumentError, parseAgentArguments } from "./agent-arguments.js";

test("agent CLI parses the Sompi API commands", () => {
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
  assert.deepEqual(parseAgentArguments(["wallet"]), { kind: "wallet" });
  assert.deepEqual(parseAgentArguments(["activity", "--limit", "50"]), { kind: "activity", limit: 50 });
  assert.deepEqual(parseAgentArguments([
    "transfer", "--request-key", "send:one", "--to",
    "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    "--amount-kas", "0.25",
  ]), {
    kind: "transfer", requestKey: "send:one",
    destination: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    amountKas: "0.25",
  });
  assert.deepEqual(parseAgentArguments(["transfer-status", "trf_AAAAAAAAAAAAAAAAAAAAAA"]), {
    kind: "transfer-status", transferId: "trf_AAAAAAAAAAAAAAAAAAAAAA",
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
    ["wallet", "extra"],
    ["activity", "--limit", "0"],
    ["activity", "--limit", "101"],
    ["transfer", "--request-key", "x", "--to", "kaspatest:x"],
    ["transfer", "--request-key", "x", "--to", "kaspatest:x", "--amount-kas", "1", "--amount-sompi", "1"],
  ]) {
    assert.throws(() => parseAgentArguments(args), AgentCliArgumentError);
  }
});
