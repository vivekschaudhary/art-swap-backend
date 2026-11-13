import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../http/app.js";
import { registerHealthRoutes, type HealthDeps } from "./health.js";
import { registerIdentityRoutes, type IdentityDeps } from "./identity.js";
import { registerTestOnlyRoutes } from "./test-only.js";

export function registerRoutes(
  app: OpenAPIHono<AppEnv>,
  opts: { env: string; health: HealthDeps; identity: IdentityDeps },
) {
  registerHealthRoutes(app, opts.health);
  registerIdentityRoutes(app, opts.identity);
  if (opts.env === "test") registerTestOnlyRoutes(app);
}
