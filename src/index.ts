// Vercel entry for the HTTP API (framework preset: Hono). Every /v1/* and /internal/jobs/* request
// is handled here. Queue consumers live in api/jobs/ and are separate functions.
import type { Hono } from "hono";
import type { AppEnv } from "./http/app.js";
import { loadEnv } from "./config/env.js";
import { buildApp, buildJobRuntime } from "./runtime.js";

const app: Hono<AppEnv> = buildApp(buildJobRuntime(loadEnv()));

export default app;
