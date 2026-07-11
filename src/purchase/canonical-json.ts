/**
 * Serializes evidence facts with deterministic object-key ordering.
 *
 * This helper belongs to Sompi rather than either protocol adapter so evidence
 * digests never inherit an unrelated protocol package's serialization rules.
 * It accepts only the JSON data model and fails closed on cycles and
 * values whose JSON representation is ambiguous.
 */
export function canonicalEvidenceJson(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} is not finite JSON data`);
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new Error(`${path} is not JSON-serializable`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path} contains a cyclic JSON value`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(`${path}[${index}] is not JSON-serializable`);
        }
        items.push(serialize(value[index], `${path}[${index}]`, ancestors));
      }
      if (Object.keys(value).length !== value.length) {
        throw new Error(`${path} has non-JSON array properties`);
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} is not a plain JSON object`);
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
