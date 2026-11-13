import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { COMMON_ERRORS, problemResponse } from "../http/schemas.js";
import { buildProblem } from "../errors/problem.js";
import type { AppEnv } from "../http/app.js";

export type HealthDeps = {
  pingDatabase: () => Promise<boolean>;
  pingObjectStore: () => Promise<boolean>;
};

const liveRoute = createRoute({
  method: "get",
  path: "/v1/health",
  operationId: "getHealth",
  tags: ["System"],
  summary: "Liveness",
  description: "Returns 200 while the process is serving requests. Does not check dependencies.",
  responses: {
    200: {
      description: "The process is up",
      content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
    },
    ...COMMON_ERRORS,
  },
});

const readyRoute = createRoute({
  method: "get",
  path: "/v1/health/ready",
  operationId: "getHealthReady",
  tags: ["System"],
  summary: "Readiness: database and object store",
  description: "Returns 200 only when the database and the private object-store bucket are reachable.",
  responses: {
    200: {
      description: "All dependencies reachable",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            checks: z.object({ database: z.literal("ok"), object_store: z.literal("ok") }),
          }),
        },
      },
    },
    503: problemResponse("A dependency is unavailable"),
    ...COMMON_ERRORS,
  },
});

export function registerHealthRoutes(app: OpenAPIHono<AppEnv>, deps: HealthDeps) {
  app.openapi(liveRoute, (c) => c.json({ status: "ok" as const }, 200));

  app.openapi(readyRoute, async (c) => {
    const [database, objectStore] = await Promise.all([deps.pingDatabase(), deps.pingObjectStore()]);
    if (!database || !objectStore) {
      const res = c.json(buildProblem("DEPENDENCY_UNAVAILABLE", "A dependency is not reachable.", c.get("requestId")), 503);
      res.headers.set("content-type", "application/problem+json");
      return res;
    }
    return c.json({ status: "ok" as const, checks: { database: "ok" as const, object_store: "ok" as const } }, 200);
  });
}
