import assert from "node:assert/strict";
import test from "node:test";

import {
  SOMPI_OPERATION_FAILURES,
  SompiOperationFailure,
  sompiOperationFailureDefinition,
  type SompiOperationFailureCode,
} from "./operation-failure.js";

test("stable operation failures have one closed safe catalog", () => {
  assert.equal(Object.isFrozen(SOMPI_OPERATION_FAILURES), true);
  const codes = Object.keys(SOMPI_OPERATION_FAILURES) as SompiOperationFailureCode[];
  assert.deepEqual(codes, [
    "PURCHASE_CONFLICT",
    "PURCHASE_NOT_FOUND",
    "PURCHASE_ADMISSION_SATURATED",
    "INVALID_TRANSFER",
    "TRANSFER_CONFLICT",
    "TRANSFER_DENIED",
    "TRANSFER_EXPIRED",
    "TRANSFER_FAILED",
    "TRANSFER_NOT_FOUND",
    "INVALID_POLICY_CHANGE",
    "POLICY_CHANGE_CONFLICT",
    "POLICY_CHANGE_NOT_FOUND",
    "INVALID_VAULT_MIGRATION",
    "VAULT_MIGRATION_CONFLICT",
    "VAULT_MIGRATION_NOT_FOUND",
  ]);

  for (const code of codes) {
    const definition = sompiOperationFailureDefinition(code);
    assert.ok(definition);
    assert.equal(Object.isFrozen(definition), true);
    assert.match(code, /^[A-Z][A-Z0-9_]{0,79}$/);
    assert.ok(definition.message.length >= 1 && definition.message.length <= 512);
    assert.doesNotMatch(definition.message, /[\u0000-\u001f\u007f]/);

    const cause = new Error("private internal detail");
    const failure = new SompiOperationFailure(code, { cause });
    assert.equal(failure.code, code);
    assert.equal(failure.message, definition.message);
    assert.equal(failure.retryable, definition.retryable);
    assert.equal(failure.cause, cause);
    assert.equal(failure.message.includes(cause.message), false);
  }

  assert.equal(sompiOperationFailureDefinition("UNKNOWN_FAILURE"), undefined);
  assert.equal(
    SOMPI_OPERATION_FAILURES.VAULT_MIGRATION_CONFLICT.message,
    "The Vault Migration conflicts with current policy or request-key state.",
  );
  assert.throws(
    () => new SompiOperationFailure("UNKNOWN_FAILURE" as SompiOperationFailureCode),
    /failure code is invalid/,
  );
});
