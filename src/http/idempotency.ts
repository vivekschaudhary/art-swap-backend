import { createHash } from "node:crypto";
import type pg from "pg";
import { DomainError } from "../errors/domain-error.js";

const TTL_HOURS = 24;

/**
 * Idempotency for POST endpoints (design §4). The first response for (user, key) is stored for 24 hours.
 * The same key with the same body replays it. The same key with a different body is a conflict.
 * Without a key, the request runs as normal.
 */
export async function withIdempotency(
  db: pg.Pool,
  opts: { userId: string; key: string | undefined; route: string; body: unknown },
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown; replayed: boolean }> {
  if (!opts.key) return { ...(await run()), replayed: false };
  const hash = createHash("sha256").update(JSON.stringify(opts.body ?? null)).digest("hex");

  const existing = await db.query<{ request_hash: string; response_status: number; response_body: unknown }>(
    "select request_hash, response_status, response_body from idempotency_keys where user_id = $1 and key = $2 and expires_at > now()",
    [opts.userId, opts.key],
  );
  const prior = existing.rows[0];
  if (prior) {
    if (prior.request_hash !== hash) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used with a different request.");
    }
    return { status: prior.response_status, body: prior.response_body, replayed: true };
  }

  const result = await run();
  await db.query(
    `insert into idempotency_keys (user_id, key, route, request_hash, response_status, response_body, expires_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, now() + make_interval(hours => $7))
     on conflict (user_id, key) do nothing`,
    [opts.userId, opts.key, opts.route, hash, result.status, JSON.stringify(result.body), TTL_HOURS],
  );
  return { ...result, replayed: false };
}
