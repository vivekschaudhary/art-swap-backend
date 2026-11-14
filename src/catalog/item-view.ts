import type pg from "pg";
import { publishReadiness } from "./readiness.js";
import { mediaUrls, type StoredVariants } from "./media.js";
import { requiredAttributes } from "./attributes.js";

export type ItemRow = {
  id: string;
  owner_id: string;
  category_id: string | null;
  category_slug: string | null;
  category_name: string | null;
  attribute_schema: object | null;
  title: string | null;
  description: string | null;
  attributes: Record<string, unknown>;
  condition: string | null;
  source: string;
  fulfillment_options: string[];
  status: string;
  area_label: string | null;
  origin_item_id: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  owner_display_name: string | null;
};

export type MediaRow = {
  id: string;
  position: number;
  status: string;
  width: number | null;
  height: number | null;
  variants: StoredVariants | null;
};

const ITEM_SELECT = `
  select i.id, i.owner_id, i.category_id, c.slug as category_slug, c.name as category_name,
         c.attribute_schema, i.title, i.description, i.attributes, i.condition, i.source,
         i.fulfillment_options, i.status, i.area_label, i.origin_item_id, i.published_at,
         i.created_at, i.updated_at, i.version, p.display_name as owner_display_name
    from items i
    left join categories c on c.id = i.category_id
    left join profiles p on p.user_id = i.owner_id`;

export async function loadItem(db: pg.Pool, id: string): Promise<ItemRow | null> {
  const { rows } = await db.query<ItemRow>(`${ITEM_SELECT} where i.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function loadMedia(db: pg.Pool, itemId: string): Promise<MediaRow[]> {
  const { rows } = await db.query<MediaRow>(
    "select id, position, status, width, height, variants from item_media where item_id = $1 order by position, created_at",
    [itemId],
  );
  return rows;
}

/**
 * Whether a viewer may see an item. Owners see everything they own. Everyone else sees only
 * available items, and never when either user has blocked the other (§7.4, §5.2).
 */
export async function canView(db: pg.Pool, item: ItemRow, viewerId: string): Promise<boolean> {
  if (item.owner_id === viewerId) return true;
  if (item.status !== "available") return false;
  const { rowCount } = await db.query(
    `select 1 from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`,
    [viewerId, item.owner_id],
  );
  return (rowCount ?? 0) === 0;
}

export type ItemOutput = ReturnType<typeof toItem>;

export function toItem(
  item: ItemRow,
  media: MediaRow[],
  opts: { viewerIsOwner: boolean; publicBucket: string; mediaBaseUrl: string },
) {
  const shown = opts.viewerIsOwner ? media : media.filter((m) => m.status === "ready");
  const mediaOut = shown.map((m) => ({
    id: m.id,
    position: m.position,
    status: m.status,
    width: m.width,
    height: m.height,
    blurhash: null,
    urls: mediaUrls(opts.mediaBaseUrl, opts.publicBucket, m.variants),
    ...(m.status === "ready" && m.variants
      ? {
          variants: {
            thumb: { w: m.variants.thumb!.w, h: m.variants.thumb!.h },
            card: { w: m.variants.card!.w, h: m.variants.card!.h },
            full: { w: m.variants.full!.w, h: m.variants.full!.h },
          },
        }
      : {}),
  }));
  const cover = mediaOut.find((m) => m.status === "ready") ?? null;

  const readiness = opts.viewerIsOwner
    ? publishReadiness({
        hasCategory: item.category_id !== null,
        hasTitle: item.title !== null,
        hasCondition: item.condition !== null,
        readyMediaCount: media.filter((m) => m.status === "ready").length,
        attributes: item.attributes,
        requiredAttributes: item.attribute_schema ? requiredAttributes(item.attribute_schema) : [],
      })
    : undefined;

  return {
    id: item.id,
    title: item.title,
    description: item.description,
    category: item.category_id ? { id: item.category_id, slug: item.category_slug!, name: item.category_name! } : null,
    condition: item.condition,
    attributes: item.attributes,
    source: item.source,
    fulfillment_options: item.fulfillment_options,
    status: item.status,
    cover,
    media: mediaOut,
    area_label: item.area_label,
    owner: { id: item.owner_id, display_name: item.owner_display_name },
    origin_item_id: item.origin_item_id,
    published_at: item.published_at?.toISOString() ?? null,
    created_at: item.created_at.toISOString(),
    updated_at: item.updated_at.toISOString(),
    version: item.version,
    ...(readiness ? { publish_readiness: readiness } : {}),
  };
}
