import { describe, expect, it } from "vitest";
import { ERROR_CATALOG } from "../src/errors/catalog.js";
import { DomainError } from "../src/errors/domain-error.js";
import { buildProblem } from "../src/errors/problem.js";
import { resolveRequestId } from "../src/http/request-id.js";
import { loadEnv } from "../src/config/env.js";

describe("request IDs", () => {
  it("keeps a well-formed client ID", () => {
    expect(resolveRequestId("abc-12345678")).toBe("abc-12345678");
  });

  it("replaces malformed or missing IDs with a 32-hex ID", () => {
    expect(resolveRequestId("bad id with spaces")).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("errors", () => {
  it("takes the HTTP status from the catalog", () => {
    const err = new DomainError("SWAP_ITEM_UNAVAILABLE", "gone");
    expect(err.status).toBe(ERROR_CATALOG.SWAP_ITEM_UNAVAILABLE);
    expect(err.status).toBe(409);
  });

  it("never leaks detail for INTERNAL", () => {
    const p = buildProblem("INTERNAL", "db password is hunter2", "rid");
    expect(p.detail).not.toContain("hunter2");
    expect(p.type).toBe("https://api.kindtree.us/errors/internal");
    expect(p.request_id).toBe("rid");
  });
});

describe("environment", () => {
  it("fails fast and names the missing variables", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("applies defaults for a complete environment", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      S3_ENDPOINT: "http://localhost:9090",
      S3_ACCESS_KEY_ID: "a",
      S3_SECRET_ACCESS_KEY: "b",
      S3_BUCKET_PUBLIC: "p",
      S3_BUCKET_PRIVATE: "q",
    });
    expect(env.APP_ROLE).toBe("api");
    expect(env.PORT).toBe(3000);
  });
});
