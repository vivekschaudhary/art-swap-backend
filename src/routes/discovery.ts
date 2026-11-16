import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type pg from "pg";
import type { Auth } from "../auth/auth.js";
import { DomainError } from "../errors/domain-error.js";
import { requireUser } from "../http/session.js";
import { COMMON_ERRORS, problemResponse } from "../http/schemas.js";
import type { AppEnv } from "../http/app.js";
import { canView, loadItem, loadMedia, toItem, type ItemRow, type MediaRow } from "../catalog/item-view.js";
import { decodeCursor, encodeCursor } from "../catalog/cursor.js";
import { decodeFeedCursor, encodeFeedCursor, type FeedRow } from "../catalog/feed-cursor.js";

export type DiscoveryDeps = { db: pg.Pool; auth: Pick<Auth, "api">; publicBucket: string; mediaBaseUrl: string };

const AUTH = { 401: problemResponse("Authentication required") } as const;
const ItemSchema = z.object({}).passthrough().openapi("FeedItem");
const Page = z.object({ data: z.array(ItemSchema), next_cursor: z.string().nullable() });

const ItemColumns = `
  i.id, i.owner_id, i.category_id, c.slug as category_slug, c.name as category_name, c.attribute_schema,
  i.title, i.description, i.attributes, i.condition, i.source, i.fulfillment_options, i.status,
  i.area_label, i.origin_item_id, i.published_at, i.created_at, i.updated_at, i.version,
  p.display_name as owner_display_name`;

const FeedQuery = z.object({
  category_ids: z.string().optional(),
  radius_km: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const feedRoute = createRoute({
  method: "get",
  path: "/v1/feed",
  operationId: "getFeed",
  tags: ["Discovery"],
  summary: "Discovery feed",
  description:
    "Available items from other users within your search radius, nearest distance first, then newest. Excludes items you've already swiped and anyone blocked in either direction. Requires onboarding.",
  request: { query: FeedQuery },
  responses: {
    200: { description: "Page of items", content: { "application/json": { schema: Page } } },
    403: problemResponse("Onboarding required"),
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

const swipeRoute = createRoute({
  method: "post",
  path: "/v1/swipes",
  operationId: "createSwipe",
  tags: ["Discovery"],
  summary: "Swipe on an item",
  description: "A right swipe means interest. The response tells the app whether to open the swap composer.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ item_id: z.string().uuid(), direction: z.enum(["left", "right"]) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Swipe recorded",
      content: {
        "application/json": {
          schema: z.object({ next_action: z.enum(["compose_swap", "none"]) }),
        },
      },
    },
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

const undoRoute = createRoute({
  method: "delete",
  path: "/v1/swipes/{item_id}",
  operationId: "deleteSwipe",
  tags: ["Discovery"],
  summary: "Undo a swipe",
  description: "Idempotent: returns 204 whether or not a swipe existed.",
  request: { params: z.object({ item_id: z.string().uuid() }) },
  responses: { 204: { description: "Undone" }, ...AUTH, ...COMMON_ERRORS },
});

const likesRoute = createRoute({
  method: "get",
  path: "/v1/me/likes",
  operationId: "listMyLikes",
  tags: ["Discovery"],
  summary: "Items you swiped right on",
  description: "Right-swiped items that are still available, most recent swipe first.",
  request: { query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }) },
  responses: {
    200: { description: "Page of items", content: { "application/json": { schema: Page } } },
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

type LikeRow = ItemRow & { liked_at: Date };

/** Distance buckets for ordering: under 5 km, 5 to 15 km, then further (design §7.7). */
export const bucketOf = (meters: number) => (meters < 5000 ? 0 : meters < 15000 ? 1 : 2);

/** Rounds to whole kilometres, never below 1 (design §7.7). */
export const roundedKm = (meters: number) => Math.max(1, Math.round(meters / 1000));

async function viewerRadius(db: pg.Pool, userId: string): Promise<{ radiusKm: number } | null> {
  const { rows } = await db.query<{ search_radius_km: number }>(
    "select search_radius_km from user_locations where user_id = $1",
    [userId],
  );
  return rows[0] ? { radiusKm: rows[0].search_radius_km } : null;
}

function feedOutput(item: ItemRow, media: MediaRow[], deps: DiscoveryDeps, distanceMeters: number) {
  return { ...toItem(item, media, { viewerIsOwner: false, publicBucket: deps.publicBucket, mediaBaseUrl: deps.mediaBaseUrl }), distance_km_rounded: roundedKm(distanceMeters) };
}

export function registerDiscoveryRoutes(app: OpenAPIHono<AppEnv>, deps: DiscoveryDeps) {
  const { db, auth } = deps;

  app.openapi(feedRoute, async (c) => {
    const user = await requireUser(auth, c);
    const q = c.req.valid("query");
    const viewer = await viewerRadius(db, user.id);
    const profile = await db.query("select onboarded_at from profiles where user_id = $1", [user.id]);
    if (!viewer || !profile.rows[0]?.onboarded_at) {
      throw new DomainError("ONBOARDING_REQUIRED", "Set a display name and location to see the feed.");
    }

    const radiusKm = q.radius_km ?? viewer.radiusKm;
    const categories = q.category_ids ? q.category_ids.split(",").map((s) => s.trim()).filter(Boolean) : null;
    if (categories && categories.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
      throw new DomainError("VALIDATION_FAILED", "category_ids must be UUIDs.", [{ field: "category_ids", message: "must be UUIDs" }]);
    }

    const cur = decodeFeedCursor(q.cursor);
    const params: unknown[] = [user.id, radiusKm * 1000, categories, cur?.b ?? null, cur?.p ?? null, cur?.id ?? null, q.limit + 1];
    const { rows } = await db.query<FeedRow>(
      `with viewer as (select location from user_locations where user_id = $1),
            feed as (
              select ${ItemColumns},
                     ST_Distance(i.location, v.location) as dist_m,
                     case when ST_Distance(i.location, v.location) < 5000 then 0
                          when ST_Distance(i.location, v.location) < 15000 then 1 else 2 end as bucket
                from items i
                cross join viewer v
                left join categories c on c.id = i.category_id
                left join profiles p on p.user_id = i.owner_id
               where i.status = 'available'
                 and i.owner_id <> $1
                 and i.location is not null
                 and ST_DWithin(i.location, v.location, $2)
                 and ($3::uuid[] is null or i.category_id = any($3::uuid[]))
                 and not exists (select 1 from swipes s where s.user_id = $1 and s.item_id = i.id)
                 and not exists (
                   select 1 from blocks b
                    where (b.blocker_id = $1 and b.blocked_id = i.owner_id)
                       or (b.blocker_id = i.owner_id and b.blocked_id = $1))
            )
       select * from feed
        where ($4::int is null
               or bucket > $4::int
               or (bucket = $4::int and (published_at < $5::timestamptz
                   or (published_at = $5::timestamptz and id < $6::uuid))))
        order by bucket, published_at desc, id desc
        limit $7`,
      params,
    );

    const page = rows.slice(0, q.limit);
    const data = [];
    for (const row of page) data.push(feedOutput(row, await loadMedia(db, row.id), deps, row.dist_m));
    const last = page[page.length - 1];
    const next_cursor = rows.length > q.limit && last ? encodeFeedCursor(last) : null;
    return c.json({ data, next_cursor } as never, 200);
  });

  app.openapi(swipeRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { item_id, direction } = c.req.valid("json");
    const item = await loadItem(db, item_id);
    if (!item) throw new DomainError("NOT_FOUND", "Item not found.");
    if (item.owner_id === user.id) {
      throw new DomainError("SWAP_OWN_ITEM", "You can't swipe on your own item.", [{ field: "item_id", message: "is your own item" }]);
    }
    if (!(await canView(db, item, user.id))) throw new DomainError("NOT_FOUND", "Item not found.");

    await db.query(
      `insert into swipes (user_id, item_id, direction) values ($1, $2, $3)
       on conflict (user_id, item_id) do update set direction = excluded.direction, created_at = now()`,
      [user.id, item_id, direction],
    );
    return c.json({ next_action: direction === "right" ? ("compose_swap" as const) : ("none" as const) }, 200);
  });

  app.openapi(undoRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { item_id } = c.req.valid("param");
    await db.query("delete from swipes where user_id = $1 and item_id = $2", [user.id, item_id]);
    return c.body(null, 204);
  });

  app.openapi(likesRoute, async (c) => {
    const user = await requireUser(auth, c);
    const q = c.req.valid("query");
    const cur = decodeCursor(q.cursor);
    const params: unknown[] = [user.id, cur?.t ?? null, cur?.id ?? null, q.limit + 1];
    const { rows } = await db.query<LikeRow>(
      `select ${ItemColumns}, s.created_at as liked_at
         from swipes s
         join items i on i.id = s.item_id
         left join categories c on c.id = i.category_id
         left join profiles p on p.user_id = i.owner_id
        where s.user_id = $1 and s.direction = 'right' and i.status = 'available'
          and not exists (
            select 1 from blocks b
             where (b.blocker_id = $1 and b.blocked_id = i.owner_id)
                or (b.blocker_id = i.owner_id and b.blocked_id = $1))
          and ($2::timestamptz is null or (s.created_at, i.id) < ($2::timestamptz, $3::uuid))
        order by s.created_at desc, i.id desc
        limit $4`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const data = [];
    for (const row of page) data.push(toItem(row, await loadMedia(db, row.id), { viewerIsOwner: false, publicBucket: deps.publicBucket, mediaBaseUrl: deps.mediaBaseUrl }));
    const last = page[page.length - 1];
    const next_cursor = rows.length > q.limit && last ? encodeCursor(last.liked_at, last.id) : null;
    return c.json({ data, next_cursor } as never, 200);
  });
}
