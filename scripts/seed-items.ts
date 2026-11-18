/**
 * Dev-only: adds listed items for one account, so the discover screens have something to show.
 * Each item reuses an existing photo, so the cards show real images. Not used by the app or by CI.
 *
 * Usage (set DATABASE_URL in your shell first, from a hidden prompt, never in a file or in chat):
 *   npx tsx scripts/seed-items.ts <user-id> [count]
 *
 * The account needs a location (onboarding), because items take their location from their owner.
 */
import pg from "pg";

const [userId, countArg] = process.argv.slice(2);
const count = Number(countArg ?? 10);
if (!userId || !Number.isInteger(count) || count < 1 || count > 50) {
  console.error("usage: npx tsx scripts/seed-items.ts <user-id> [count 1-50]");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
const CONDITIONS = ["new", "like_new", "good", "fair"] as const;

async function main() {
  const client = await pool.connect();
  try {
    const owner = await client.query("select area_label from user_locations where user_id = $1", [userId]);
    if (owner.rowCount === 0) throw new Error("That account has no location yet. Set one in onboarding first.");

    const cat = await client.query<{ id: string }>("select id from categories where slug = 'art'");
    if (cat.rowCount === 0) throw new Error("No 'art' category found.");

    // A photo to reuse: any ready image from an item that already has one.
    const photo = await client.query<{ original_key: string; mime: string; bytes: number; width: number | null; height: number | null; variants: unknown }>(
      "select original_key, mime, bytes, width, height, variants from item_media where status = 'ready' and variants is not null order by created_at limit 1",
    );
    if (photo.rowCount === 0) throw new Error("No ready photo exists to reuse. Upload one through the app first.");
    const src = photo.rows[0]!;

    await client.query("begin");
    const ids: string[] = [];
    for (let n = 1; n <= count; n++) {
      const item = await client.query<{ id: string }>(
        `insert into items (owner_id, category_id, title, description, condition, attributes, status, published_at, location, area_label)
         select $1, $2, $3, $4, $5, '{}'::jsonb, 'available', now(), ul.location, ul.area_label
           from user_locations ul where ul.user_id = $1
         returning id`,
        [userId, cat.rows[0]!.id, `Seed art ${n}`, `Sample listing ${n} for trying the screens.`, CONDITIONS[(n - 1) % CONDITIONS.length]],
      );
      const id = item.rows[0]!.id;
      await client.query(
        `insert into item_media (item_id, status, original_key, variants, mime, bytes, width, height, position)
         values ($1, 'ready', $2, $3::jsonb, $4, $5, $6, $7, 0)`,
        [id, src.original_key, JSON.stringify(src.variants), src.mime, src.bytes, src.width, src.height],
      );
      ids.push(id);
    }
    await client.query("commit");
    console.log(`Added ${ids.length} listed items for that account.`);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
