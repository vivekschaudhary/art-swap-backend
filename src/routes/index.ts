import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../http/app.js";
import { registerHealthRoutes, type HealthDeps } from "./health.js";
import { registerIdentityRoutes, type IdentityDeps } from "./identity.js";
import { registerTestOnlyRoutes } from "./test-only.js";
import { registerCatalogRoutes, type CatalogDeps } from "./catalog.js";
import { registerDiscoveryRoutes, type DiscoveryDeps } from "./discovery.js";
import { registerSwapRoutes, type SwapDeps } from "./swaps.js";

export function registerRoutes(
  app: OpenAPIHono<AppEnv>,
  opts: { env: string; health: HealthDeps; identity: IdentityDeps; catalog: CatalogDeps; discovery: DiscoveryDeps; swaps: SwapDeps },
) {
  registerHealthRoutes(app, opts.health);
  registerIdentityRoutes(app, opts.identity);
  registerCatalogRoutes(app, opts.catalog);
  registerDiscoveryRoutes(app, opts.discovery);
  registerSwapRoutes(app, opts.swaps);
  if (opts.env === "test") registerTestOnlyRoutes(app, opts.identity.db);
}
