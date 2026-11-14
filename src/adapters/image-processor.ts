import sharp from "sharp";

/** Longest-edge sizes in pixels for each served variant (docs/v1-design.md §5.3). */
export const VARIANT_SIZES = { thumb: 400, card: 1080, full: 2048 } as const;
export type VariantKind = keyof typeof VARIANT_SIZES;

export type ProcessedVariant = { kind: VariantKind; bytes: Buffer; width: number; height: number };
export type ProcessedImage = { width: number; height: number; variants: ProcessedVariant[] };

/**
 * Decodes an image, applies its EXIF orientation, and writes WebP variants.
 * sharp drops metadata by default, so EXIF (including GPS) never reaches the output.
 * Images are never enlarged. A variant larger than the source is the source size.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const probe = await sharp(input, { failOn: "error" }).metadata();
  if (!probe.width || !probe.height) throw new Error("image has no dimensions");

  const variants: ProcessedVariant[] = [];
  for (const kind of Object.keys(VARIANT_SIZES) as VariantKind[]) {
    const size = VARIANT_SIZES[kind];
    const { data, info } = await sharp(input, { failOn: "error" })
      .rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    variants.push({ kind, bytes: data, width: info.width, height: info.height });
  }
  return { width: probe.width, height: probe.height, variants };
}
