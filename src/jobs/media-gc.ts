import type pg from "pg";
import type { ObjectStore } from "../adapters/object-store.js";

/**
 * Cron job media-gc (design §8). Removes uploads that were never completed, older than 24 hours,
 * along with their objects. Ready media is never touched. Idempotent: re-running finds nothing new.
 */
export async function mediaGc(deps: { db: pg.Pool; store: ObjectStore; privateBucket: string }): Promise<{ removed: number }> {
  const { rows } = await deps.db.query<{ id: string; original_key: string }>(
    `select id, original_key from item_media
      where status = 'pending' and created_at < now() - interval '24 hours'
      limit 500`,
  );
  if (rows.length === 0) return { removed: 0 };
  await deps.store.deleteKeys(deps.privateBucket, rows.map((r) => r.original_key));
  await deps.db.query("delete from item_media where id = any($1::uuid[])", [rows.map((r) => r.id)]);
  return { removed: rows.length };
}
