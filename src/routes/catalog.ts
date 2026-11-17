import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ObjectStore } from "../adapters/object-store.js";
import type { JobQueue } from "../adapters/job-queue.js";
import type { Logger } from "../logging/logger.js";
import type { Auth } from "../auth/auth.js";
import { DomainError, type FieldError } from "../errors/domain-error.js";
import { requireUser } from "../http/session.js";
import { COMMON_ERRORS, problemResponse } from "../http/schemas.js";
import type { AppEnv } from "../http/app.js";
import { buildProblem } from "../errors/problem.js";
import { validateAttributes, requiredAttributes } from "../catalog/attributes.js";
import { publishReadiness } from "../catalog/readiness.js";
import {
  ALLOWED_MIME,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_PER_ITEM,
  originalKey,
  sniffMime,
} from "../catalog/media.js";
import { canView, loadItem, loadMedia, toItem, type ItemRow } from "../catalog/item-view.js";
import { decodeCursor, encodeCursor } from "../catalog/cursor.js";

export const DRAFT_LIMIT = 50;
const UPLOAD_TTL_SECONDS = 600;
const LOCKED_STATUSES = ["reserved", "swapped", "archived"];

export type CatalogDeps = {
  db: pg.Pool;
  auth: Pick<Auth, "api">;
  store: ObjectStore;
  queue: JobQueue;
  logger: Logger;
  privateBucket: string;
  publicBucket: string;
  mediaBaseUrl: string;
};

const AUTH = { 401: problemResponse("Authentication required") } as const;

const ItemSchema = z.object({}).passthrough().openapi("Item");
const ItemList = z.object({ data: z.array(ItemSchema), next_cursor: z.string().nullable() });

const CreateItemBody = z.object({
  category_id: z.string().uuid().optional(),
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  condition: z.enum(["new", "like_new", "good", "fair"]).optional(),
  fulfillment_options: z.array(z.enum(["local_pickup", "shipping", "either"])).optional(),
});

const PatchItemBody = CreateItemBody;
const idParam = z.object({ id: z.string().uuid() });
const ListQuery = z.object({
  status: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const listCategories = createRoute({
  method: "get",
  path: "/v1/categories",
  operationId: "listCategories",
  tags: ["Catalog"],
  summary: "Categories",
  description: "Active categories with their attribute JSON Schema.",
  responses: {
    200: {
      description: "Categories",
      content: {
        "application/json": {
          schema: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), attribute_schema: z.object({}).passthrough() })),
        },
      },
    },
    ...COMMON_ERRORS,
  },
});

const listMyItems = createRoute({
  method: "get",
  path: "/v1/me/items",
  operationId: "listMyItems",
  tags: ["Catalog"],
  summary: "My items",
  description: "Items you own, newest first. Filter with status=draft,available,reserved,swapped,archived.",
  request: { query: ListQuery },
  responses: { 200: { description: "Page of items", content: { "application/json": { schema: ItemList } } }, ...AUTH, ...COMMON_ERRORS },
});

const listMyDrafts = createRoute({
  method: "get",
  path: "/v1/me/drafts",
  operationId: "listMyDrafts",
  tags: ["Catalog"],
  summary: "My drafts",
  description: "Your drafts, most recently edited first.",
  request: { query: ListQuery.pick({ cursor: true, limit: true }) },
  responses: { 200: { description: "Page of drafts", content: { "application/json": { schema: ItemList } } }, ...AUTH, ...COMMON_ERRORS },
});

const createItem = createRoute({
  method: "post",
  path: "/v1/items",
  operationId: "createItem",
  tags: ["Catalog"],
  summary: "Start a draft",
  description: "Creates a draft. Every field is optional. Drafts are limited to 50 per user.",
  request: { body: { required: false, content: { "application/json": { schema: CreateItemBody } } } },
  responses: {
    201: { description: "Draft created", content: { "application/json": { schema: ItemSchema } } },
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

const getItem = createRoute({
  method: "get",
  path: "/v1/items/{id}",
  operationId: "getItem",
  tags: ["Catalog"],
  summary: "Item",
  description: "Owners see every status. Others see only available items, and never when blocked.",
  request: { params: idParam },
  responses: { 200: { description: "Item", content: { "application/json": { schema: ItemSchema } } }, ...AUTH, ...COMMON_ERRORS },
});

const patchItem = createRoute({
  method: "patch",
  path: "/v1/items/{id}",
  operationId: "updateItem",
  tags: ["Catalog"],
  summary: "Update an item",
  description: "Partial update for the owner. Send If-Match with the version you last saw. A stale version returns 412 with the current item.",
  request: { params: idParam, body: { required: true, content: { "application/json": { schema: PatchItemBody } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: ItemSchema } } },
    412: { description: "Version conflict; body includes current", content: { "application/problem+json": { schema: z.object({}).passthrough() } } },
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

const deleteItem = createRoute({
  method: "delete",
  path: "/v1/items/{id}",
  operationId: "deleteItem",
  tags: ["Catalog"],
  summary: "Delete or archive an item",
  description: "Never-published drafts are removed with their media. Anything else is archived.",
  request: { params: idParam },
  responses: { 204: { description: "Deleted or archived" }, ...AUTH, ...COMMON_ERRORS },
});

const publishItem = createRoute({
  method: "post",
  path: "/v1/items/{id}/publish",
  operationId: "publishItem",
  tags: ["Catalog"],
  summary: "Publish a draft",
  description: "Requires title, category, condition, all required attributes, a ready image and an onboarded owner.",
  request: { params: idParam },
  responses: { 200: { description: "Published", content: { "application/json": { schema: ItemSchema } } }, ...AUTH, ...COMMON_ERRORS },
});

const unpublishItem = createRoute({
  method: "post",
  path: "/v1/items/{id}/unpublish",
  operationId: "unpublishItem",
  tags: ["Catalog"],
  summary: "Return an item to draft",
  description: "Not allowed while the item is reserved, swapped or archived.",
  request: { params: idParam },
  responses: { 200: { description: "Draft", content: { "application/json": { schema: ItemSchema } } }, ...AUTH, ...COMMON_ERRORS },
});

const createUploads = createRoute({
  method: "post",
  path: "/v1/items/{id}/media/uploads",
  operationId: "createMediaUploads",
  tags: ["Media"],
  summary: "Request upload URLs",
  description: "Returns one presigned PUT URL per file. Send the bytes straight to the URL, then call complete.",
  request: {
    params: idParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ files: z.array(z.object({ mime: z.string(), bytes: z.number().int().positive() })).min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Upload slots",
      content: {
        "application/json": {
          schema: z.object({
            uploads: z.array(
              z.object({ media_id: z.string(), upload_url: z.string(), headers: z.record(z.string(), z.string()), expires_at: z.string() }),
            ),
          }),
        },
      },
    },
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

const completeUploads = createRoute({
  method: "post",
  path: "/v1/items/{id}/media/complete",
  operationId: "completeMediaUploads",
  tags: ["Media"],
  summary: "Confirm uploads and queue processing",
  description: "Checks each upload is a real image of the declared type, then queues processing. Poll the item for status ready.",
  request: { params: idParam, body: { required: true, content: { "application/json": { schema: z.object({ media_ids: z.array(z.string().uuid()).min(1) }) } } } },
  responses: {
    202: { description: "Queued", content: { "application/json": { schema: z.object({ media: z.array(z.object({}).passthrough()) }) } } },
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

const provenance = createRoute({
  method: "get",
  path: "/v1/items/{id}/provenance",
  operationId: "getItemProvenance",
  tags: ["Catalog"],
  summary: "Ownership history",
  description: "Oldest first. Each entry is an item in the chain, with its owner and creation time.",
  request: { params: idParam },
  responses: {
    200: {
      description: "Chain",
      content: {
        "application/json": {
          schema: z.array(z.object({ item_id: z.string(), owner: z.object({ id: z.string(), display_name: z.string().nullable() }), created_at: z.string() })),
        },
      },
    },
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

async function categoryById(db: pg.Pool, id: string) {
  const { rows } = await db.query<{ id: string; attribute_schema: object }>(
    "select id, attribute_schema from categories where id = $1 and is_active",
    [id],
  );
  return rows[0] ?? null;
}

async function ownedItem(db: pg.Pool, id: string, viewerId: string): Promise<ItemRow> {
  const item = await loadItem(db, id);
  if (!item || item.owner_id !== viewerId) throw new DomainError("NOT_FOUND", "Item not found.");
  return item;
}

async function viewOf(deps: CatalogDeps, item: ItemRow, viewerId: string) {
  const media = await loadMedia(deps.db, item.id);
  return toItem(item, media, {
    viewerIsOwner: item.owner_id === viewerId,
    mediaBaseUrl: deps.mediaBaseUrl,
  });
}

async function reload(deps: CatalogDeps, id: string, viewerId: string) {
  const item = await loadItem(deps.db, id);
  if (!item) throw new DomainError("NOT_FOUND", "Item not found.");
  return viewOf(deps, item, viewerId);
}

function assertFulfillment(options: string[] | undefined) {
  if (options && options.some((o) => o !== "local_pickup")) {
    throw new DomainError("FULFILLMENT_NOT_SUPPORTED", "Only local pickup is available in this version.", [
      { field: "fulfillment_options", message: "only local_pickup is supported" },
    ]);
  }
}

async function listItems(
  deps: CatalogDeps,
  viewerId: string,
  opts: { statuses: string[] | null; cursor?: string; limit: number },
) {
  const cur = decodeCursor(opts.cursor);
  const params: unknown[] = [viewerId, opts.limit + 1];
  let where = "i.owner_id = $1";
  if (opts.statuses) {
    params.push(opts.statuses);
    where += ` and i.status = any($${params.length}::text[])`;
  }
  if (cur) {
    params.push(cur.t, cur.id);
    where += ` and (i.created_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  const { rows } = await deps.db.query<ItemRow>(
    `select i.id, i.owner_id, i.category_id, c.slug as category_slug, c.name as category_name, c.attribute_schema,
            i.title, i.description, i.attributes, i.condition, i.source, i.fulfillment_options, i.status,
            i.area_label, i.origin_item_id, i.published_at, i.created_at, i.updated_at, i.version,
            p.display_name as owner_display_name
       from items i left join categories c on c.id = i.category_id left join profiles p on p.user_id = i.owner_id
      where ${where}
      order by i.created_at desc, i.id desc
      limit $2`,
    params,
  );
  const page = rows.slice(0, opts.limit);
  const data = [];
  for (const row of page) data.push(await viewOf(deps, row, viewerId));
  const last = page[page.length - 1];
  return { data, next_cursor: rows.length > opts.limit && last ? encodeCursor(last.created_at, last.id) : null };
}

export function registerCatalogRoutes(app: OpenAPIHono<AppEnv>, deps: CatalogDeps) {
  const { db, store, queue, auth } = deps;

  app.openapi(listCategories, async (c) => {
    await requireUser(auth, c);
    const { rows } = await db.query<{ id: string; slug: string; name: string; attribute_schema: object }>(
      "select id, slug, name, attribute_schema from categories where is_active order by sort_order, name",
    );
    return c.json(rows, 200);
  });

  app.openapi(listMyItems, async (c) => {
    const user = await requireUser(auth, c);
    const q = c.req.valid("query");
    const statuses = q.status ? q.status.split(",").map((s) => s.trim()).filter(Boolean) : null;
    return c.json(await listItems(deps, user.id, { statuses, cursor: q.cursor, limit: q.limit }), 200);
  });

  app.openapi(listMyDrafts, async (c) => {
    const user = await requireUser(auth, c);
    const q = c.req.valid("query");
    return c.json(await listItems(deps, user.id, { statuses: ["draft"], cursor: q.cursor, limit: q.limit }), 200);
  });

  app.openapi(createItem, async (c) => {
    const user = await requireUser(auth, c);
    const body = c.req.valid("json");
    assertFulfillment(body.fulfillment_options);

    const count = await db.query<{ n: string }>("select count(*)::text as n from items where owner_id = $1 and status = 'draft'", [user.id]);
    if (Number(count.rows[0]!.n) >= DRAFT_LIMIT) {
      throw new DomainError("DRAFT_LIMIT_REACHED", `You can keep up to ${DRAFT_LIMIT} drafts. Publish or delete some first.`);
    }

    let schema: object | null = null;
    if (body.category_id) {
      const category = await categoryById(db, body.category_id);
      if (!category) throw new DomainError("VALIDATION_FAILED", "Unknown category.", [{ field: "category_id", message: "is not an active category" }]);
      schema = category.attribute_schema;
    }
    if (body.attributes && schema) {
      const errors = validateAttributes(schema, body.attributes, "partial");
      if (errors.length) throw new DomainError("VALIDATION_FAILED", "Some attributes are invalid.", errors);
    }

    const { rows } = await db.query<{ id: string }>(
      `insert into items (owner_id, category_id, title, description, attributes, condition, fulfillment_options)
       values ($1, $2, $3, $4, $5::jsonb, $6, coalesce($7::text[], '{local_pickup}'))
       returning id`,
      [
        user.id,
        body.category_id ?? null,
        body.title ?? null,
        body.description ?? null,
        JSON.stringify(body.attributes ?? {}),
        body.condition ?? null,
        body.fulfillment_options ?? null,
      ],
    );
    const view = await reload(deps, rows[0]!.id, user.id);
    return c.json(view as never, 201);
  });

  app.openapi(getItem, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const item = await loadItem(db, id);
    if (!item || !(await canView(db, item, user.id))) throw new DomainError("NOT_FOUND", "Item not found.");
    return c.json((await viewOf(deps, item, user.id)) as never, 200);
  });

  app.openapi(patchItem, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const item = await ownedItem(db, id, user.id);

    const ifMatch = c.req.header("if-match");
    if (ifMatch !== undefined && Number(ifMatch) !== item.version) {
      return c.json(conflictBody(await reload(deps, id, user.id), c.get("requestId")), 412, {
        "content-type": "application/problem+json",
      } as never);
    }
    if (LOCKED_STATUSES.includes(item.status)) throw new DomainError("ITEM_LOCKED", "This item can't be edited right now.");
    assertFulfillment(body.fulfillment_options);

    const categoryId = body.category_id ?? item.category_id;
    let schema: object | null = null;
    if (categoryId) {
      const category = await categoryById(db, categoryId);
      if (!category) throw new DomainError("VALIDATION_FAILED", "Unknown category.", [{ field: "category_id", message: "is not an active category" }]);
      schema = category.attribute_schema;
    }
    const attributes = body.attributes ?? null;
    if (attributes && schema) {
      const errors = validateAttributes(schema, attributes, "partial");
      if (errors.length) throw new DomainError("VALIDATION_FAILED", "Some attributes are invalid.", errors);
    }

    const updated = await db.query(
      `update items set
          category_id = coalesce($2::uuid, category_id),
          title = coalesce($3, title),
          description = coalesce($4, description),
          attributes = coalesce($5::jsonb, attributes),
          condition = coalesce($6, condition),
          fulfillment_options = coalesce($7::text[], fulfillment_options),
          version = version + 1, updated_at = now()
        where id = $1 and version = $8`,
      [
        id,
        body.category_id ?? null,
        body.title ?? null,
        body.description ?? null,
        attributes ? JSON.stringify(attributes) : null,
        body.condition ?? null,
        body.fulfillment_options ?? null,
        item.version,
      ],
    );
    if ((updated.rowCount ?? 0) === 0) {
      return c.json(conflictBody(await reload(deps, id, user.id), c.get("requestId")), 412, {
        "content-type": "application/problem+json",
      } as never);
    }
    return c.json((await reload(deps, id, user.id)) as never, 200);
  });

  app.openapi(deleteItem, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const item = await ownedItem(db, id, user.id);
    if (LOCKED_STATUSES.includes(item.status)) throw new DomainError("ITEM_LOCKED", "This item can't be deleted right now.");

    const removable = item.status === "draft" && item.source === "created" && item.published_at === null;
    if (removable) {
      const media = await db.query<{ id: string; original_key: string; variants: Record<string, { key: string }> | null }>(
        "select id, original_key, variants from item_media where item_id = $1",
        [id],
      );
      const privateKeys = media.rows.map((m) => m.original_key);
      const publicKeys = media.rows.flatMap((m) => Object.values(m.variants ?? {}).map((v) => v.key));
      await store.deleteKeys(deps.privateBucket, privateKeys);
      await store.deleteKeys(deps.publicBucket, publicKeys);
      await db.query("delete from items where id = $1", [id]);
    } else {
      await db.query("update items set status = 'archived', version = version + 1, updated_at = now() where id = $1", [id]);
    }
    return c.body(null, 204);
  });

  app.openapi(publishItem, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const item = await ownedItem(db, id, user.id);
    if (item.status !== "draft") throw new DomainError("ITEM_LOCKED", "Only drafts can be published.");

    const media = await loadMedia(db, id);
    const schema = item.attribute_schema;
    const readiness = publishReadiness({
      hasCategory: item.category_id !== null,
      hasTitle: item.title !== null,
      hasCondition: item.condition !== null,
      readyMediaCount: media.filter((m) => m.status === "ready").length,
      attributes: item.attributes,
      requiredAttributes: schema ? requiredAttributes(schema) : [],
    });
    const errors: FieldError[] = readiness.missing.map((field) => ({ field, message: "is required" }));
    if (schema) errors.push(...validateAttributes(schema, item.attributes, "full"));
    if (errors.length) {
      throw new DomainError("ITEM_NOT_PUBLISHABLE", "This draft isn't ready to publish yet.", errors);
    }

    const owner = await db.query(
      `select 1 from profiles p join user_locations l on l.user_id = p.user_id
        where p.user_id = $1 and p.display_name is not null`,
      [user.id],
    );
    if ((owner.rowCount ?? 0) === 0) {
      throw new DomainError("ONBOARDING_REQUIRED", "Set a display name and location before publishing.");
    }

    await db.query(
      `update items set status = 'available', published_at = now(), version = version + 1, updated_at = now(),
              location = (select l.location from user_locations l where l.user_id = items.owner_id),
              area_label = (select l.area_label from user_locations l where l.user_id = items.owner_id)
        where id = $1`,
      [id],
    );
    return c.json((await reload(deps, id, user.id)) as never, 200);
  });

  app.openapi(unpublishItem, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const item = await ownedItem(db, id, user.id);
    if (LOCKED_STATUSES.includes(item.status)) throw new DomainError("ITEM_LOCKED", "This item can't be unpublished right now.");
    if (item.status === "available") {
      await db.query("update items set status = 'draft', version = version + 1, updated_at = now() where id = $1", [id]);
    }
    return c.json((await reload(deps, id, user.id)) as never, 200);
  });

  app.openapi(createUploads, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const { files } = c.req.valid("json");
    const item = await ownedItem(db, id, user.id);
    if (LOCKED_STATUSES.includes(item.status)) throw new DomainError("ITEM_LOCKED", "Media can't be added right now.");

    const existing = await db.query<{ n: string }>(
      "select count(*)::text as n from item_media where item_id = $1 and status <> 'failed'",
      [id],
    );
    if (Number(existing.rows[0]!.n) + files.length > MAX_MEDIA_PER_ITEM) {
      throw new DomainError("MEDIA_LIMIT_EXCEEDED", `An item can have up to ${MAX_MEDIA_PER_ITEM} photos.`);
    }
    for (const f of files) {
      if (!(ALLOWED_MIME as readonly string[]).includes(f.mime)) {
        throw new DomainError("MEDIA_INVALID", "That file type isn't supported.", [{ field: "mime", message: `${f.mime} is not allowed` }]);
      }
      if (f.bytes > MAX_MEDIA_BYTES) throw new DomainError("MEDIA_INVALID", "That file is too large.", [{ field: "bytes", message: "must be 15 MB or less" }]);
    }

    const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);
    const uploads = [];
    for (const [index, f] of files.entries()) {
      const mediaId = randomUUID();
      const key = originalKey(id, mediaId);
      await db.query(
        `insert into item_media (id, item_id, status, original_key, mime, bytes, position)
         values ($1, $2, 'pending', $3, $4, $5, $6)`,
        [mediaId, id, key, f.mime, f.bytes, Number(existing.rows[0]!.n) + index],
      );
      const url = await store.presignPut({
        bucket: deps.privateBucket,
        key,
        contentType: f.mime,
        expiresInSeconds: UPLOAD_TTL_SECONDS,
      });
      uploads.push({ media_id: mediaId, upload_url: url, headers: { "content-type": f.mime }, expires_at: expiresAt.toISOString() });
    }
    return c.json({ uploads }, 200);
  });

  app.openapi(completeUploads, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const { media_ids } = c.req.valid("json");
    await ownedItem(db, id, user.id);

    const out: unknown[] = [];
    for (const mediaId of media_ids) {
      const { rows } = await db.query<{ id: string; original_key: string; mime: string; status: string }>(
        "select id, original_key, mime, status from item_media where id = $1 and item_id = $2",
        [mediaId, id],
      );
      const row = rows[0];
      if (!row) throw new DomainError("NOT_FOUND", "Media not found.");
      if (row.status !== "pending") {
        out.push({ id: row.id, status: row.status });
        continue;
      }

      const head = await store.head(deps.privateBucket, row.original_key);
      const reject = async (message: string) => {
        await db.query("update item_media set status = 'failed', updated_at = now() where id = $1", [mediaId]);
        await store.deleteKeys(deps.privateBucket, [row.original_key]);
        throw new DomainError("MEDIA_INVALID", message);
      };
      if (!head) await reject("The upload wasn't received.");
      if (head!.size > MAX_MEDIA_BYTES) await reject("That file is too large.");
      const sniffed = sniffMime(await store.readPrefix(deps.privateBucket, row.original_key, 64));
      if (sniffed !== row.mime) await reject("The file isn't a valid image of the declared type.");

      await db.query("update item_media set status = 'processing', updated_at = now() where id = $1", [mediaId]);
      await queue.send("media-process", { mediaId }, { singletonKey: mediaId });
      out.push({ id: row.id, status: "processing" });
    }
    return c.json({ media: out } as never, 202);
  });

  app.openapi(provenance, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const item = await loadItem(db, id);
    if (!item || !(await canView(db, item, user.id))) throw new DomainError("NOT_FOUND", "Item not found.");
    const { rows } = await db.query<{ item_id: string; owner_id: string; display_name: string | null; created_at: Date }>(
      `with recursive chain as (
         select i.id, i.owner_id, i.created_at, i.origin_item_id, 0 as depth from items i where i.id = $1
         union all
         select o.id, o.owner_id, o.created_at, o.origin_item_id, c.depth + 1
           from items o join chain c on o.id = c.origin_item_id
       )
       select chain.id as item_id, chain.owner_id, p.display_name, chain.created_at
         from chain left join profiles p on p.user_id = chain.owner_id
        order by chain.depth desc`,
      [id],
    );
    return c.json(
      rows.map((r) => ({
        item_id: r.item_id,
        owner: { id: r.owner_id, display_name: r.display_name },
        created_at: r.created_at.toISOString(),
      })),
      200,
    );
  });
}

function conflictBody(current: unknown, requestId: string) {
  return { ...buildProblem("VERSION_CONFLICT", "This item changed on another device.", requestId), current };
}
