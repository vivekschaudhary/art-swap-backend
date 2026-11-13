// Keeps the eval error catalog identical to docs/v1-design.md §10.2.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../spec/error-codes.ts";

const doc = readFileSync(fileURLToPath(new URL("../../docs/v1-design.md", import.meta.url)), "utf8");
const section = doc.slice(doc.indexOf("### 10.2"), doc.indexOf("### 10.3"));

const fromDoc = new Map<string, number>();
for (const line of section.split("\n")) {
  const m = /^\|\s*`([A-Z_]+)`\s*\|\s*(\d{3})\s*\|/.exec(line);
  if (m) fromDoc.set(m[1]!, Number(m[2]));
}

describe("error catalog matches docs/v1-design.md §10.2", () => {
  it("parses a non-empty catalog from the doc", () => {
    expect(fromDoc.size).toBeGreaterThan(20);
  });

  it("has the same codes and HTTP statuses on both sides", () => {
    expect(Object.fromEntries(fromDoc)).toEqual({ ...ERROR_CODES });
  });
});
