import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as Ajv2020Module from "ajv/dist/2020.js";
import type {
  Ajv2020 as Ajv2020Instance,
  Options as AjvOptions,
  ValidateFunction,
} from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const Ajv2020 = (
  (Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module
) as new (options?: AjvOptions) => Ajv2020Instance;

export const AP2_SCHEMA_DIGESTS = Object.freeze({
  "checkout_mandate.json": "10c0341edfeaa9084d3704ef8e94869de20499c8e357068d65f8d622bf79483a",
  "payment_mandate.json": "94c4af64ed29825cb956705ae763d42f3c04d22feb60b8d838dae2bb1eea1fb1",
  "checkout_receipt.json": "941198a1fc1916d04813a8b8ccba4b407471305a6eb1b5338b1f67b6299764ea",
  "payment_receipt.json": "e7d52266c407d32bcc49959f91e8ddb73024a1803bef75b7bd368fb93849ba88",
  "types/amount.json": "15271efa8064539b8ded7c69f213ed7a1e64f8d9634b405ce926c2dcbbc41c0f",
  "types/merchant.json": "13457334d8577230a1cce5265971cfc02f68f5d4e97f74bd2e78128105d3ab31",
  "types/payment_instrument.json": "b3bcea7a7b5bbf2b0aa781135ac3b6907280822aa84797161c2d3d104d0cbe8c",
  "types/pisp.json": "60a5c8c09236f5d1e84a25bff4fd4cff05fb3fa8e3648cbab483322f27388630",
  "types/receipt_status.json": "ad51c1c20be72e286f4ff6fe2819145dcec7e5e3e0f6dc7870fcf748c06c1da0",
} as const);

export type Ap2SchemaName = keyof typeof AP2_SCHEMA_DIGESTS;

export interface Ap2SchemaValidators {
  checkoutMandate: ValidateFunction;
  paymentMandate: ValidateFunction;
  checkoutReceipt: ValidateFunction;
  paymentReceipt: ValidateFunction;
}

export class Ap2SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ap2SchemaError";
  }
}

export function loadPinnedAp2Schemas(
  root = path.resolve(MODULE_DIRECTORY, "../../../vendor/ap2-v0.2-schemas")
): Ap2SchemaValidators {
  const schemas = new Map<Ap2SchemaName, Record<string, unknown>>();
  for (const [name, expected] of Object.entries(AP2_SCHEMA_DIGESTS) as Array<[
    Ap2SchemaName,
    string,
  ]>) {
    const filename = path.resolve(root, name);
    if (!filename.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new Ap2SchemaError("AP2 schema path escaped its pinned root");
    }
    const bytes = fs.readFileSync(filename);
    if (sha256(bytes) !== expected) {
      throw new Ap2SchemaError(`AP2 schema ${name} does not match pinned upstream bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Ap2SchemaError(`AP2 schema ${name} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Ap2SchemaError(`AP2 schema ${name} has an invalid root`);
    }
    schemas.set(name, parsed as Record<string, unknown>);
  }

  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    allErrors: false,
    validateFormats: true,
  });
  (addFormatsModule as unknown as (instance: Ajv2020Instance) => void)(ajv);
  ajv.addKeyword({ keyword: "x-selectively-disclosable-field", schemaType: "boolean", valid: true });
  for (const schema of schemas.values()) ajv.addSchema(schema);
  // Upstream v0.2 uses both spellings between $id and Receipt refs.
  const receiptStatus = schemas.get("types/receipt_status.json")!;
  ajv.addSchema(receiptStatus, "https://ap2-protocol.org/schemas/types/receipt_status.json");

  return Object.freeze({
    checkoutMandate: requiredValidator(
      ajv,
      "https://ap2-protocol.org/schemas/checkout_mandate.json"
    ),
    paymentMandate: requiredValidator(
      ajv,
      "https://ap2-protocol.org/schemas/payment_mandate.json"
    ),
    checkoutReceipt: requiredValidator(
      ajv,
      "https://ap2-protocol.org/schemas/checkout_receipt.json"
    ),
    paymentReceipt: requiredValidator(
      ajv,
      "https://ap2-protocol.org/schemas/payment_receipt.json"
    ),
  });
}

function requiredValidator(ajv: Ajv2020Instance, id: string): ValidateFunction {
  const validator = ajv.getSchema(id);
  if (!validator) throw new Ap2SchemaError(`pinned AP2 validator ${id} was not registered`);
  return validator;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
