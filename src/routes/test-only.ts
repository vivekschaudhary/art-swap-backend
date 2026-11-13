import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { COMMON_ERRORS } from "../http/schemas.js";
import type { AppEnv } from "../http/app.js";

/**
 * Routes used only by the M1 evals (evals/scenarios/m1-foundations). Registered only when NODE_ENV=test.
 * Never registered in development or production.
 */
const echoRoute = createRoute({
  method: "post",
  path: "/v1/__test/echo",
  operationId: "testEcho",
  tags: ["Test"],
  summary: "Validation and echo target (test mode only)",
  description: "Echoes a validated integer. Exists only when NODE_ENV=test.",
  request: {
    body: { content: { "application/json": { schema: z.object({ n: z.number().int() }) } }, required: true },
  },
  responses: {
    200: { description: "Echoed", content: { "application/json": { schema: z.object({ n: z.number().int() }) } } },
    ...COMMON_ERRORS,
  },
});

const boomRoute = createRoute({
  method: "get",
  path: "/v1/__test/boom",
  operationId: "testBoom",
  tags: ["Test"],
  summary: "Throws an unexpected error (test mode only)",
  description: "Throws an unhandled error so the 500 path can be verified. Exists only when NODE_ENV=test.",
  responses: { ...COMMON_ERRORS },
});

export function registerTestOnlyRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(echoRoute, (c) => {
    const body = c.req.valid("json");
    return c.json({ n: body.n }, 200);
  });

  app.openapi(boomRoute, () => {
    throw new Error("boom-internal-secret");
  });
}
