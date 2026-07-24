export interface SompiOperationFailureDefinition {
  readonly message: string;
  readonly retryable: boolean;
}

export const SOMPI_OPERATION_FAILURES = Object.freeze({
  PURCHASE_CONFLICT: definition(
    "The Purchase request key is already bound to different intent.",
    false,
  ),
  PURCHASE_NOT_FOUND: definition("The Purchase does not exist.", false),
  PURCHASE_ADMISSION_SATURATED: definition(
    "Purchase admission is saturated.",
    true,
  ),
  INVALID_TRANSFER: definition(
    "The Transfer request is invalid or current spending protection does not permit it.",
    false,
  ),
  TRANSFER_CONFLICT: definition(
    "The Transfer request key is already bound to different intent.",
    false,
  ),
  TRANSFER_DENIED: definition("The Transfer was denied.", false),
  TRANSFER_EXPIRED: definition("The Transfer approval expired.", false),
  TRANSFER_FAILED: definition(
    "The Transfer needs safe recovery. Retry only with the same Transfer ID.",
    true,
  ),
  TRANSFER_NOT_FOUND: definition("The Transfer does not exist.", false),
  INVALID_POLICY_CHANGE: definition(
    "The Policy Change request is invalid or exceeds current protection.",
    false,
  ),
  POLICY_CHANGE_CONFLICT: definition(
    "The Policy Change conflicts with current policy or request-key state.",
    false,
  ),
  POLICY_CHANGE_NOT_FOUND: definition("The Policy Change does not exist.", false),
  INVALID_VAULT_MIGRATION: definition(
    "The Vault Migration request is invalid or exceeds current protection.",
    false,
  ),
  VAULT_MIGRATION_CONFLICT: definition(
    "The Vault Migration conflicts with current policy or request-key state.",
    false,
  ),
  VAULT_MIGRATION_NOT_FOUND: definition("The Vault Migration does not exist.", false),
} as const);

export type SompiOperationFailureCode = keyof typeof SOMPI_OPERATION_FAILURES;

export class SompiOperationFailure extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: SompiOperationFailureCode,
    options?: ErrorOptions,
  ) {
    const entry = sompiOperationFailureDefinition(code);
    if (!entry) throw new TypeError("Sompi operation failure code is invalid");
    super(entry.message, options);
    this.name = "SompiOperationFailure";
    this.retryable = entry.retryable;
  }
}

export function sompiOperationFailureDefinition(
  code: string,
): SompiOperationFailureDefinition | undefined {
  if (!Object.prototype.hasOwnProperty.call(SOMPI_OPERATION_FAILURES, code)) {
    return undefined;
  }
  return SOMPI_OPERATION_FAILURES[code as SompiOperationFailureCode];
}

function definition(
  message: string,
  retryable: boolean,
): SompiOperationFailureDefinition {
  return Object.freeze({ message, retryable });
}
