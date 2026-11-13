import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { HTTPResponseError } from "hono/types";
import type { ErrorCode } from "../errors/catalog.js";
import { DomainError, type FieldError } from "../errors/domain-error.js";
import { buildProblem, problemResponse } from "../errors/problem.js";
import type { Logger } from "../logging/logger.js";
import { resolveRequestId } from "./request-id.js";

export type AppDeps = { logger: Logger; env: "development" | "test" | "production" };

export type RequestVars = { requestId: string; startedAt: number };
export type AppEnv = { Variables: RequestVars };

/** Maps a Zod validation failure to the §10.1 VALIDATION_FAILED body instead of the library default. */
function validationHook(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, c: Context) {
  if (result.success) return;
  const errors: FieldError[] = (result.error?.issues ?? []).map((i) => ({
    field: i.path.map(String).join(".") || "body",
    message: i.message,
  }));
  return problemResponse(c, buildProblem("VALIDATION_FAILED", "One or more fields are invalid.", c.get("requestId"), errors));
}

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  // Request ID and access log (§10.4). Runs for every request, including errors.
  app.use("*", async (c, next) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    c.set("requestId", requestId);
    c.set("startedAt", performance.now());
    await next();
    c.header("x-request-id", requestId);
    const latency = Math.round((performance.now() - c.get("startedAt")) * 100) / 100;
    deps.logger.info(
      {
        request_id: requestId,
        trace_id: requestId,
        route: c.req.path,
        method: c.req.method,
        status: c.res.status,
        latency_ms: latency,
      },
      "request",
    );
  });

  app.notFound((c) =>
    problemResponse(c, buildProblem("NOT_FOUND", `No route for ${c.req.method} ${c.req.path}.`, c.get("requestId"))),
  );

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? resolveRequestId(undefined);
    if (err instanceof DomainError) {
      return problemResponse(c, buildProblem(err.code, err.message, requestId, err.errors));
    }
    const mapped = mapHttpError(err);
    if (mapped.code === "INTERNAL") {
      // Full error with stack goes to the logs only. The response body stays generic.
      deps.logger.error(
        { request_id: requestId, trace_id: requestId, route: c.req.path, method: c.req.method, status: 500, err },
        "unhandled error",
      );
    }
    return problemResponse(c, buildProblem(mapped.code, mapped.detail, requestId));
  });

  return app;
}

/** Converts framework errors (for example malformed JSON from Hono) into catalog codes. */
function mapHttpError(err: unknown): { code: ErrorCode; detail: string } {
  const status = (err as Partial<HTTPResponseError>).getResponse?.()?.status;
  if (status === 400) return { code: "VALIDATION_FAILED", detail: "The request body is malformed." };
  if (status === 404) return { code: "NOT_FOUND", detail: "Not found." };
  if (status === 401) return { code: "UNAUTHENTICATED", detail: "Authentication required." };
  if (status === 403) return { code: "FORBIDDEN", detail: "Not allowed." };
  if (status === 429) return { code: "RATE_LIMITED", detail: "Too many requests." };
  return { code: "INTERNAL", detail: "An unexpected error occurred." };
}

