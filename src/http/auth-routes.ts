import type { Hono } from "hono";
import type { Auth } from "../auth/auth.js";
import { buildProblem, problemResponse } from "../errors/problem.js";
import type { ErrorCode } from "../errors/catalog.js";
import type { AppEnv } from "./app.js";

/**
 * Mounts Better Auth at /v1/auth/*. Successful responses pass through unchanged (cookies and the
 * set-auth-token header included). Failures are rewritten to problem+json with a catalog code (§10.1).
 */
export function registerAuthRoutes(app: Hono<AppEnv>, auth: Auth) {
  app.on(["GET", "POST"], "/v1/auth/*", async (c) => {
    const res = await auth.handler(c.req.raw);
    if (res.status < 400) return res;

    const requestId = c.get("requestId");
    const code: ErrorCode = res.status === 429 ? "RATE_LIMITED" : res.status === 404 ? "NOT_FOUND" : "UNAUTHENTICATED";
    let detail = "Authentication failed.";
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message && code !== "UNAUTHENTICATED") detail = body.message;
    } catch {
      // non-JSON error bodies keep the generic detail
    }
    return problemResponse(c, buildProblem(code, detail, requestId));
  });
}
