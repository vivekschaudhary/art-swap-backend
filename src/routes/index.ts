import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../http/app.js";
import { registerHealthRoutes, type HealthDeps } from "./health.js";
import { registerTestOnlyRoutes } from "./test-only.js";

export function registerRoutes(app: OpenAPIHono<AppEnv>, opts: { env: string; health: HealthDeps }) {
  registerHealthRoutes(app, opts.health);
  if (opts.env === "test") registerTestOnlyRoutes(app);
}
