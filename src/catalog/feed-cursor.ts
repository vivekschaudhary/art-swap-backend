import { DomainError } from "../errors/domain-error.js";
import type { ItemRow } from "./item-view.js";

/** A feed row: an item with its distance in meters and its distance bucket (design §7.7). */
export type FeedRow = ItemRow & { dist_m: number; bucket: number };

/** Opaque keyset cursor: distance bucket, publish time and id of the last item on a page. */
export function encodeFeedCursor(row: FeedRow): string {
  return Buffer.from(JSON.stringify({ b: row.bucket, p: row.published_at?.toISOString() ?? null, id: row.id })).toString("base64url");
}

export function decodeFeedCursor(cursor: string | undefined): { b: number; p: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { b: number; p: string; id: string };
    if (typeof parsed.b !== "number" || !parsed.p || !parsed.id) throw new Error("incomplete");
    return parsed;
  } catch {
    throw new DomainError("VALIDATION_FAILED", "The cursor is not valid.");
  }
}
