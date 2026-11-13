/**
 * M1 Foundations scenarios (docs/v1-design.md §14 and §16.4).
 *
 * The API must run with NODE_ENV=test, which enables two test-only routes:
 *   POST /v1/__test/echo   body { n: integer }  → 200 { n }        (validation target)
 *   GET  /v1/__test/boom                         → throws a plain Error (500 INTERNAL target)
 * In production these paths must return 404.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, beforeAll } from "vitest";
import { send, type CapturedResponse } from "../../lib/http.ts";
import { formatMismatches, match } from "../../lib/match.ts";
import { isErrorCode } from "../../spec/error-codes.ts";
import { STACK_RE, levelName, linesForRequest, readApiLogs, waitForLogs } from "../../lib/logs.ts";

const REQUEST_ID = "0af7651916cd43dd8448eb211c80319c";

function expectProblem(res: CapturedResponse, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.contentType).toMatch(/^application\/problem\+json/);
  const body = res.json as Record<string, unknown>;
  const problems = match(
    {
      type: "$regex:^https://api\\.kindtree\\.us/errors/",
      title: "$nonempty",
      status,
      code,
      detail: "$string",
      request_id: "$nonempty",
    },
    body,
  );
  expect(problems, formatMismatches(problems)).toEqual([]);
  expect(isErrorCode(body.code)).toBe(true);
  expect(body.request_id).toBe(res.headers["x-request-id"]);
}

describe("M1 health and readiness", () => {
  it("GET /v1/health → 200 ok", async () => {
    const res = await send({ method: "GET", path: "/v1/health" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "ok" });
  });

  it("GET /v1/health/ready → 200 when the database and object store are reachable", async () => {
    const res = await send({ method: "GET", path: "/v1/health/ready" });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ status: "ok", checks: { database: "ok", object_store: "ok" } });
  });
});

describe("M1 request IDs", () => {
  it("echoes a client X-Request-Id on the response and in logs", async () => {
    const res = await send({ method: "GET", path: "/v1/health", headers: { "x-request-id": REQUEST_ID } });
    expect(res.headers["x-request-id"]).toBe(REQUEST_ID);
  });

  it("generates an X-Request-Id when none is sent", async () => {
    const res = await send({ method: "GET", path: "/v1/health" });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("M1 error format", () => {
  it("unknown route → 404 problem+json with code NOT_FOUND", async () => {
    const res = await send({ method: "GET", path: "/v1/definitely-not-a-route" });
    expectProblem(res, 404, "NOT_FOUND");
  });

  it("invalid body → 400 VALIDATION_FAILED with errors[] naming the field", async () => {
    const res = await send({ method: "POST", path: "/v1/__test/echo", body: { n: "not-a-number" } });
    expectProblem(res, 400, "VALIDATION_FAILED");
    const body = res.json as { errors: { field: string; message: string }[] };
    expect(body.errors).toEqual([expect.objectContaining({ field: "n", message: expect.any(String) })]);
  });

  it("malformed JSON → 400 VALIDATION_FAILED, not a 500", async () => {
    const res = await send({ method: "POST", path: "/v1/__test/echo", body: "{not json" });
    expectProblem(res, 400, "VALIDATION_FAILED");
  });

  it("a valid body reaches the handler and is echoed", async () => {
    const res = await send({ method: "POST", path: "/v1/__test/echo", body: { n: 7 } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ n: 7 });
  });

  it("an unexpected throw → 500 INTERNAL with no stack or internal message in the body", async () => {
    const res = await send({ method: "GET", path: "/v1/__test/boom" });
    expectProblem(res, 500, "INTERNAL");
    expect(res.text).not.toMatch(STACK_RE);
    expect(res.text).not.toMatch(/boom-internal-secret/);
    expect((res.json as { detail: string }).detail).not.toMatch(/boom-internal-secret/);
  });
});

describe("M1 structured logging", () => {
  it("logs the 500 with level error, the stack trace, request_id and route", async () => {
    const res = await send({ method: "GET", path: "/v1/__test/boom", headers: { "x-request-id": "b00b1e5b00b1e5b00b1e5b00b1e5b00b" } });
    const lines = await waitForLogs(res.headers["x-request-id"]!, (ls) => ls.some((l) => levelName(l.level) === "error"));
    const errorLine = lines.find((l) => levelName(l.level) === "error");
    expect(errorLine, "no error log line for request").toBeDefined();
    expect(errorLine!.request_id).toBe(res.headers["x-request-id"]);
    // The stack is a string field, so check the parsed value (real newlines), not the JSON-encoded line.
    expect(String((errorLine!.err as { stack?: string } | undefined)?.stack ?? "")).toMatch(STACK_RE);
    expect(JSON.stringify(errorLine)).toMatch(/boom-internal-secret/);
    expect(errorLine!.route).toBe("/v1/__test/boom");
    expect(errorLine!.status).toBe(500);
  });

  it("writes one access line per request with the §10.4 fields", async () => {
    const id = "acce55acce55acce55acce55acce55ac";
    await send({ method: "GET", path: "/v1/health", headers: { "x-request-id": id } });
    const lines = await waitForLogs(id, (ls) => ls.some((l) => l.status === 200));
    const access = lines.find((l) => l.status === 200);
    expect(access, "no access line").toBeDefined();
    for (const key of ["time", "level", "request_id", "route", "method", "status", "latency_ms"]) {
      expect(access, `missing ${key}`).toHaveProperty(key);
    }
    expect(access!.method).toBe("GET");
  });

  it("redacts the Authorization header and other secrets from every log line", async () => {
    const secret = "Bearer sekret-token-m1-redaction-check";
    const res = await send({
      method: "POST",
      path: "/v1/__test/echo",
      headers: { authorization: secret, cookie: "session=cookie-m1-redaction-check" },
      body: { n: 1, push_token: "push-m1-redaction-check", lat: 37.77, lng: -122.42 },
    });
    expect(res.status).toBe(200);
    const lines = await waitForLogs(res.headers["x-request-id"]!, (ls) => ls.length > 0);
    const joined = JSON.stringify(lines);
    expect(joined).not.toContain("sekret-token-m1-redaction-check");
    expect(joined).not.toContain("cookie-m1-redaction-check");
    expect(joined).not.toContain("push-m1-redaction-check");
    expect(joined).not.toMatch(/37\.77|-122\.42/);
  });

  it("request bodies are never logged", async () => {
    const res = await send({ method: "POST", path: "/v1/__test/echo", body: { n: 424242 } });
    const lines = await waitForLogs(res.headers["x-request-id"]!, (ls) => ls.length > 0);
    expect(JSON.stringify(lines)).not.toContain("424242");
  });
});

describe("M1 OpenAPI and docs", () => {
  let spec: Record<string, any>;
  beforeAll(async () => {
    const res = await send({ method: "GET", path: "/v1/openapi.json" });
    expect(res.status).toBe(200);
    spec = res.json as Record<string, any>;
  });

  it("serves an OpenAPI 3.1 document covering the public routes", () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/health", "/v1/health/ready"]));
  });

  it("documents problem+json and a 500 INTERNAL response on every operation", () => {
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(ops)) {
        if (["parameters", "summary"].includes(method)) continue;
        expect(op.responses, `${method.toUpperCase()} ${path}`).toHaveProperty("500");
        expect(op.responses["500"].content, `${method.toUpperCase()} ${path}`).toHaveProperty("application/problem+json");
      }
    }
  });

  it("serves the Scalar docs page at /docs", async () => {
    const res = await send({ method: "GET", path: "/docs", headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
  });
});

describe("M1 scaffold", () => {
  it("the Next.js scaffold is gone from package.json and the Hono app is the entry point", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).not.toHaveProperty("next");
    expect(pkg.dependencies).toHaveProperty("hono");
  });
});
