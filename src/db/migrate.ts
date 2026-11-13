import { readdirSync, readFileSync } from "node:fs";
import type pg from "pg";

/**
 * Applies every *.sql file in ./migrations in name order, once each, inside a transaction.
 * Tracked in schema_migrations. Forward-only (expand, then contract; §12).
 */
export async function migrate(pool: pg.Pool, log: (name: string) => void = () => {}): Promise<string[]> {
  await pool.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const dir = new URL("./migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await pool.query("select 1 from schema_migrations where name = $1", [file]);
    if ((done.rowCount ?? 0) > 0) continue;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(readFileSync(new URL(file, dir), "utf8"));
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      applied.push(file);
      log(file);
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}
