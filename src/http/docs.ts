import type { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { AppEnv } from "./app.js";
import { OPENAPI_DOC } from "./openapi-config.js";

/** Serves the OpenAPI 3.1 document at /v1/openapi.json and the Scalar UI at /docs (§7.2). */
export function registerDocs(app: OpenAPIHono<AppEnv>) {
  app.doc31("/v1/openapi.json", OPENAPI_DOC);
  app.get("/docs", Scalar({ url: "/v1/openapi.json", pageTitle: "Kindtree Swap API" }));
}
