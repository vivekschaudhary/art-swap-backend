import type { OpenAPIHono } from "@hono/zod-openapi";
import { timingSafeEqual } from "node:crypto";
import type { AppEnv } from "./app.js";
import { DomainError } from "../errors/domain-error.js";
import type { Logger } from "../logging/logger.js";
import { CRON_JOBS, type CronJob } from "../jobs/topics.js";

/**
 * Cron targets (design §8). Vercel Cron calls these with `Authorization: Bearer <CRON_SECRET>`.
 * They are excluded from the public OpenAPI document, so they're registered with plain Hono routes.
 */
export function registerInternalJobRoutes(
  app: OpenAPIHono<AppEnv>,
  opts: { cronSecret: string | undefined; handlers: Record<CronJob, () => Promise<Record<string, unknown>>>; logger: Logger },
) {
  app.get("/internal/jobs/cron/:name", async (c) => {
    if (!authorized(c.req.header("authorization"), opts.cronSecret)) {
      throw new DomainError("UNAUTHENTICATED", "Authentication required.");
    }
    const name = c.req.param("name");
    if (!(CRON_JOBS as readonly string[]).includes(name)) throw new DomainError("NOT_FOUND", "Unknown job.");
    const result = await opts.handlers[name as CronJob]();
    opts.logger.info({ job: name, result }, "cron job finished");
    return c.json({ job: name, ...result }, 200);
  });
}

/** Constant-time comparison of the bearer token with the configured secret. */
export function authorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
