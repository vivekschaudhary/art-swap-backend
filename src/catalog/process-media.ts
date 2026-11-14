import type pg from "pg";
import type { ObjectStore } from "../adapters/object-store.js";
import { processImage } from "../adapters/image-processor.js";
import type { Logger } from "../logging/logger.js";
import { variantKey, type StoredVariants } from "./media.js";

/**
 * Worker job media.process (§8). Reads the original from the private bucket, writes WebP variants to
 * the public bucket, and marks the media ready. Failures mark it failed and keep no partial variants.
 */
export async function processMedia(
  deps: { db: pg.Pool; store: ObjectStore; privateBucket: string; publicBucket: string; logger: Logger },
  mediaId: string,
): Promise<void> {
  const { db, store, privateBucket, publicBucket, logger } = deps;
  const { rows } = await db.query<{ item_id: string; original_key: string }>(
    "select item_id, original_key from item_media where id = $1 and status in ('pending', 'processing')",
    [mediaId],
  );
  const row = rows[0];
  if (!row) return; // already processed or discarded: nothing to do, so the job is idempotent

  try {
    const original = await store.read(privateBucket, row.original_key);
    const image = await processImage(original);
    const stored: StoredVariants = {};
    for (const v of image.variants) {
      const key = variantKey(row.item_id, mediaId, v.kind);
      await store.put(publicBucket, key, v.bytes, "image/webp");
      stored[v.kind] = { key, w: v.width, h: v.height };
    }
    await db.query(
      `update item_media set status = 'ready', width = $2, height = $3, variants = $4::jsonb, updated_at = now()
        where id = $1`,
      [mediaId, image.width, image.height, JSON.stringify(stored)],
    );
  } catch (err) {
    logger.warn({ media_id: mediaId, err: { name: (err as Error).name, message: (err as Error).message } }, "media processing failed");
    await db.query("update item_media set status = 'failed', updated_at = now() where id = $1", [mediaId]);
  }
}
