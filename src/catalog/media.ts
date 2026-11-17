/** Media helpers: content sniffing, storage keys and public URLs (§5.3, §7.6). */

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
export const MAX_MEDIA_PER_ITEM = 10;
export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
export type MediaMime = (typeof ALLOWED_MIME)[number];

/** Identifies an image from its first bytes. Returns null when the bytes match no supported format. */
export function sniffMime(head: Buffer): MediaMime | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 4 && head.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (head.length >= 12 && head.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = head.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "heim", "heis", "mif1"].includes(brand)) return "image/heic";
  }
  return null;
}

export const originalKey = (itemId: string, mediaId: string) => `items/${itemId}/${mediaId}/original`;
export const variantKey = (itemId: string, mediaId: string, kind: string) => `items/${itemId}/${mediaId}/${kind}.webp`;

export type StoredVariant = { key: string; w: number; h: number };
export type StoredVariants = Partial<Record<"thumb" | "card" | "full", StoredVariant>>;

/** Public URLs for a ready item's variants. Pending or failed media expose no URLs. */
/** The media domain serves the public bucket at its root, so the bucket name is not part of the path. */
export function mediaUrls(baseUrl: string, variants: StoredVariants | null) {
  if (!variants || !variants.thumb || !variants.card || !variants.full) return {};
  const url = (v: StoredVariant) => `${baseUrl.replace(/\/$/, "")}/${v.key}`;
  return { thumb: url(variants.thumb), card: url(variants.card), full: url(variants.full) };
}
