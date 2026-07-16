import type { PurchaseApplication, PurchaseCreateRequest } from "../api/contracts.js";
import type { PurchaseView } from "../purchase/types.js";

export interface PurchaseIdentityInput {
  readonly purchaseId: string;
}

export interface PurchaseToolHandlers {
  purchase(input: PurchaseCreateRequest, signal?: AbortSignal): Promise<PurchaseView>;
  purchaseStatus(input: PurchaseIdentityInput, signal?: AbortSignal): Promise<PurchaseView>;
  purchaseRecover(input: PurchaseIdentityInput, signal?: AbortSignal): Promise<PurchaseView>;
}

/** Shared compatibility handlers; all validation and behavior live at the Purchase API seam. */
export function createPurchaseToolHandlers(application: PurchaseApplication): PurchaseToolHandlers {
  return Object.freeze({
    purchase: (input: PurchaseCreateRequest, signal?: AbortSignal) => application.purchase(input, signal),
    purchaseStatus: ({ purchaseId }: PurchaseIdentityInput, signal?: AbortSignal) => application.status(purchaseId, signal),
    purchaseRecover: ({ purchaseId }: PurchaseIdentityInput, signal?: AbortSignal) => application.recover(purchaseId, signal),
  });
}
