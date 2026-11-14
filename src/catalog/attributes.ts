import { Ajv, type ValidateFunction } from "ajv";
import type { FieldError } from "../errors/domain-error.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new Map<string, ValidateFunction>();

function compile(schema: object, partial: boolean): ValidateFunction {
  const effective = partial ? { ...schema, required: [] } : schema;
  const key = `${partial ? "p" : "f"}:${JSON.stringify(effective)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const fn = ajv.compile(effective);
  cache.set(key, fn);
  return fn;
}

/**
 * Validates category attributes against the category's JSON Schema (§5.3).
 * Drafts are checked partially: only the fields present are type-checked. Publishing checks the
 * whole object, including required fields.
 */
export function validateAttributes(schema: object, attributes: unknown, mode: "partial" | "full"): FieldError[] {
  const validate = compile(schema, mode === "partial");
  if (validate(attributes)) return [];
  return (validate.errors ?? []).map((e) => {
    const missing = e.keyword === "required" ? (e.params as { missingProperty: string }).missingProperty : null;
    const path = missing ? `${e.instancePath}/${missing}` : e.instancePath;
    const field = ["attributes", ...path.split("/").filter(Boolean)].join(".");
    return { field, message: e.message ?? "is invalid" };
  });
}

/** Names of the required attributes in a category schema. */
export function requiredAttributes(schema: object): string[] {
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : [];
}
