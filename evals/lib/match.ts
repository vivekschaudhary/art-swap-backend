/**
 * Partial deep matcher used by scenario assertions.
 *
 * - Objects match partially: only the keys in `expected` are checked.
 * - Arrays match element-wise and must have the same length, unless written as
 *   `{ $includes: [...] }`, which only requires each expected element to match some actual element.
 * - String matchers:
 *     "$any"        anything, including undefined
 *     "$exists"     anything except undefined
 *     "$absent"     key must be missing (or undefined)
 *     "$string" / "$number" / "$boolean" / "$array" / "$object"
 *     "$nonempty"   non-empty string or array
 *     "$regex:<re>" string matching the regular expression
 */
export type Mismatch = { path: string; expected: unknown; actual: unknown; reason: string };

export function match(expected: unknown, actual: unknown, path = "$"): Mismatch[] {
  if (typeof expected === "string" && expected.startsWith("$")) {
    return matchOperator(expected, actual, path);
  }

  if (isPlainObject(expected) && "$includes" in expected) {
    const wanted = expected.$includes;
    if (!Array.isArray(wanted)) return [fail(path, expected, actual, "$includes needs an array")];
    if (!Array.isArray(actual)) return [fail(path, expected, actual, "expected an array")];
    const out: Mismatch[] = [];
    wanted.forEach((w, i) => {
      if (!actual.some((a) => match(w, a, path).length === 0)) {
        out.push(fail(`${path}[$includes ${i}]`, w, actual, "no element matches"));
      }
    });
    return out;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [fail(path, expected, actual, "expected an array")];
    if (actual.length !== expected.length) {
      return [fail(path, expected.length, actual.length, "array length differs")];
    }
    return expected.flatMap((e, i) => match(e, actual[i], `${path}[${i}]`));
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return [fail(path, expected, actual, "expected an object")];
    return Object.entries(expected).flatMap(([k, v]) => match(v, actual[k], `${path}.${k}`));
  }

  return Object.is(expected, actual) ? [] : [fail(path, expected, actual, "not equal")];
}

function matchOperator(op: string, actual: unknown, path: string): Mismatch[] {
  const ok = (cond: boolean, reason: string) => (cond ? [] : [fail(path, op, actual, reason)]);
  if (op.startsWith("$regex:")) {
    const re = new RegExp(op.slice("$regex:".length));
    return ok(typeof actual === "string" && re.test(actual), "regex did not match");
  }
  switch (op) {
    case "$any":
      return [];
    case "$exists":
      return ok(actual !== undefined, "expected a value");
    case "$absent":
      return ok(actual === undefined, "expected key to be absent");
    case "$string":
      return ok(typeof actual === "string", "expected a string");
    case "$number":
      return ok(typeof actual === "number" && Number.isFinite(actual), "expected a number");
    case "$boolean":
      return ok(typeof actual === "boolean", "expected a boolean");
    case "$array":
      return ok(Array.isArray(actual), "expected an array");
    case "$object":
      return ok(isPlainObject(actual), "expected an object");
    case "$nonempty":
      return ok(
        (typeof actual === "string" || Array.isArray(actual)) && actual.length > 0,
        "expected a non-empty string or array",
      );
    default:
      throw new Error(`Unknown matcher ${op} at ${path}`);
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, expected: unknown, actual: unknown, reason: string): Mismatch {
  return { path, expected, actual, reason };
}

export function formatMismatches(ms: Mismatch[]): string {
  return ms
    .map((m) => `  ${m.path}: ${m.reason}\n    expected: ${JSON.stringify(m.expected)}\n    actual:   ${JSON.stringify(m.actual)}`)
    .join("\n");
}
