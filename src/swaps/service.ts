import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { ObjectStore } from "../adapters/object-store.js";
import { DomainError } from "../errors/domain-error.js";
import { loadItem, loadMedia, type ItemRow } from "../catalog/item-view.js";
import { mediaUrls, originalKey, variantKey, type StoredVariants } from "../catalog/media.js";

export const SWAP_TTL_DAYS = 28;

export type SwapCtx = {
  db: pg.Pool;
  store: ObjectStore;
  privateBucket: string;
  publicBucket: string;
  mediaBaseUrl: string;
};

type Client = pg.PoolClient;

/** Runs fn inside a transaction. Any thrown error rolls everything back. */
export async function inTx<T>(db: pg.Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

type SwapRow = {
  id: string;
  requester_id: string;
  recipient_id: string;
  status: string;
  fulfillment_method: string;
  note: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  completed_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
  version: number;
  created_at: Date;
};

const SWAP_COLUMNS = `id, requester_id, recipient_id, status, fulfillment_method, note, expires_at, accepted_at,
  completed_at, closed_at, close_reason, version, created_at`;

async function lockSwap(c: Client, id: string): Promise<SwapRow | null> {
  const { rows } = await c.query<SwapRow>(`select ${SWAP_COLUMNS} from swaps where id = $1 for update`, [id]);
  return rows[0] ?? null;
}

async function event(c: Client, swapId: string, actorId: string | null, type: string, payload: Record<string, unknown> = {}) {
  await c.query("insert into swap_events (swap_id, actor_id, type, payload) values ($1, $2, $3, $4::jsonb)", [
    swapId,
    actorId,
    type,
    JSON.stringify(payload),
  ]);
}

/** A snapshot is taken when a swap is requested, so later edits to the listing don't change the offer. */
export function buildSnapshot(item: ItemRow, media: { status: string; variants: StoredVariants | null; position: number }[]) {
  const cover = media.filter((m) => m.status === "ready" && m.variants).sort((a, b) => a.position - b.position)[0];
  return {
    item_id: item.id,
    title: item.title,
    category: item.category_slug ? { slug: item.category_slug, name: item.category_name } : null,
    condition: item.condition,
    cover_variants: cover?.variants ?? null,
  };
}

/** Creates a pending swap. Rules are in design §6.1. Returns the new swap id. */
export async function createSwap(
  ctx: SwapCtx,
  viewerId: string,
  body: { requested_item_id: string; offered_item_id: string; note?: string },
): Promise<string> {
  const requested = await loadItem(ctx.db, body.requested_item_id);
  const offered = await loadItem(ctx.db, body.offered_item_id);
  if (!requested || !offered) throw new DomainError("NOT_FOUND", "Item not found.");
  if (requested.owner_id === viewerId || offered.owner_id !== viewerId) {
    throw new DomainError("SWAP_OWN_ITEM", "Request an item from someone else, and offer one of your own.", [
      { field: requested.owner_id === viewerId ? "requested_item_id" : "offered_item_id", message: "does not belong to the right person" },
    ]);
  }
  const blocked = await ctx.db.query(
    "select 1 from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)",
    [viewerId, requested.owner_id],
  );
  if ((blocked.rowCount ?? 0) > 0) throw new DomainError("USER_BLOCKED", "You can't request items from this person.");
  if (requested.status !== "available" || offered.status !== "available") {
    throw new DomainError("SWAP_ITEM_UNAVAILABLE", "One of the items is no longer available.");
  }

  return inTx(ctx.db, async (c) => {
    const dup = await c.query(
      `select 1 from swaps s join swap_items si on si.swap_id = s.id
        where s.requester_id = $1 and s.status = 'pending' and si.item_id = $2`,
      [viewerId, body.requested_item_id],
    );
    if ((dup.rowCount ?? 0) > 0) throw new DomainError("SWAP_DUPLICATE", "You already have a pending request for this item.");

    const { rows } = await c.query<{ id: string }>(
      `insert into swaps (requester_id, recipient_id, expires_at, note)
       values ($1, $2, now() + make_interval(days => $3), $4) returning id`,
      [viewerId, requested.owner_id, SWAP_TTL_DAYS, body.note ?? null],
    );
    const swapId = rows[0]!.id;

    await c.query("insert into swap_participants (swap_id, user_id, role) values ($1, $2, 'requester'), ($3, $4, 'recipient')", [
      swapId,
      viewerId,
      swapId,
      requested.owner_id,
    ]);

    const requestedMedia = await loadMedia(c as unknown as pg.Pool, requested.id);
    const offeredMedia = await loadMedia(c as unknown as pg.Pool, offered.id);
    await c.query(
      `insert into swap_items (swap_id, item_id, from_user_id, to_user_id, snapshot) values
         ($1, $2, $3, $4, $5::jsonb),
         ($1, $6, $4, $3, $7::jsonb)`,
      [
        swapId,
        offered.id,
        viewerId,
        requested.owner_id,
        JSON.stringify(buildSnapshot(offered, offeredMedia)),
        requested.id,
        JSON.stringify(buildSnapshot(requested, requestedMedia)),
      ],
    );
    await event(c, swapId, viewerId, "created");

    // One conversation per swap, created with it (design §5.6).
    const convo = await c.query<{ id: string }>("insert into conversations (swap_id) values ($1) returning id", [swapId]);
    await c.query(
      "insert into conversation_participants (conversation_id, user_id) values ($1, $2), ($1, $3)",
      [convo.rows[0]!.id, viewerId, requested.owner_id],
    );
    return swapId;
  });
}

export type AcceptResult = { ok: true; swapId: string } | { ok: false; conflict: true; currentVersion: number };

/**
 * The accept transaction (design §6.1): lock the swap, check it's still pending and not expired, lock
 * both items in id order, reserve them, and invalidate every other pending swap that uses either item.
 */
export async function acceptSwap(ctx: SwapCtx, viewerId: string, swapId: string, ifMatch: number | undefined): Promise<AcceptResult> {
  return inTx(ctx.db, async (c) => {
    const swap = await lockSwap(c, swapId);
    if (!swap) throw new DomainError("NOT_FOUND", "Swap not found.");
    if (swap.requester_id === viewerId) throw new DomainError("FORBIDDEN", "Only the recipient can accept this swap.");
    if (swap.recipient_id !== viewerId) throw new DomainError("NOT_FOUND", "Swap not found.");
    if (ifMatch !== undefined && ifMatch !== swap.version) return { ok: false, conflict: true, currentVersion: swap.version };
    if (swap.status === "pending" && swap.expires_at.getTime() <= Date.now()) throw new DomainError("SWAP_EXPIRED", "This request has expired.");
    if (swap.status !== "pending") throw new DomainError("SWAP_INVALID_TRANSITION", `A ${swap.status} swap can't be accepted.`);

    const items = await c.query<{ id: string; status: string }>(
      `select si.item_id as id, i.status from swap_items si join items i on i.id = si.item_id
        where si.swap_id = $1 order by si.item_id for update of i`,
      [swapId],
    );
    if (items.rows.some((i) => i.status !== "available")) {
      throw new DomainError("SWAP_ITEM_UNAVAILABLE", "One of the items was just taken by another swap.");
    }
    const ids = items.rows.map((i) => i.id);
    await c.query("update items set status = 'reserved', version = version + 1, updated_at = now() where id = any($1::uuid[])", [ids]);
    await c.query("update swaps set status = 'accepted', accepted_at = now(), version = version + 1, updated_at = now() where id = $1", [swapId]);

    const others = await c.query<{ id: string }>(
      `select s.id from swaps s
        where s.status = 'pending' and s.id <> $2
          and s.id in (select swap_id from swap_items where item_id = any($1::uuid[]))
        for update`,
      [ids, swapId],
    );
    for (const o of others.rows) {
      await c.query(
        `update swaps set status = 'unavailable', closed_at = now(), close_reason = 'item_reserved',
                version = version + 1, updated_at = now() where id = $1`,
        [o.id],
      );
      await event(c, o.id, null, "invalidated", { by_swap: swapId });
    }
    await event(c, swapId, viewerId, "accepted");
    return { ok: true, swapId };
  });
}

/** Recipient declines, or requester withdraws. Both only apply while pending. */
export async function closePending(ctx: SwapCtx, viewerId: string, swapId: string, kind: "declined" | "withdrawn"): Promise<void> {
  await inTx(ctx.db, async (c) => {
    const swap = await lockSwap(c, swapId);
    if (!swap) throw new DomainError("NOT_FOUND", "Swap not found.");
    const actingRole = swap.recipient_id === viewerId ? "recipient" : swap.requester_id === viewerId ? "requester" : null;
    if (!actingRole) throw new DomainError("NOT_FOUND", "Swap not found.");
    const allowed = kind === "declined" ? "recipient" : "requester";
    if (actingRole !== allowed) {
      throw new DomainError("FORBIDDEN", kind === "declined" ? "Only the recipient can decline." : "Only the requester can withdraw.");
    }
    if (swap.status === "pending" && swap.expires_at.getTime() <= Date.now()) throw new DomainError("SWAP_EXPIRED", "This request has expired.");
    if (swap.status !== "pending") throw new DomainError("SWAP_INVALID_TRANSITION", `A ${swap.status} swap can't be ${kind}.`);
    await c.query(`update swaps set status = $2, closed_at = now(), closed_by = $3, version = version + 1, updated_at = now() where id = $1`, [
      swapId,
      kind,
      viewerId,
    ]);
    await event(c, swapId, viewerId, kind);
  });
}

/** Either side cancels an accepted swap. A reason is required. Reserved items become available again. */
export async function cancelSwap(ctx: SwapCtx, viewerId: string, swapId: string, reason: string): Promise<void> {
  await inTx(ctx.db, async (c) => {
    const swap = await lockSwap(c, swapId);
    if (!swap || (swap.requester_id !== viewerId && swap.recipient_id !== viewerId)) throw new DomainError("NOT_FOUND", "Swap not found.");
    if (swap.status !== "accepted") throw new DomainError("SWAP_INVALID_TRANSITION", `A ${swap.status} swap can't be cancelled.`);
    await c.query(
      `update items set status = 'available', version = version + 1, updated_at = now()
        where id in (select item_id from swap_items where swap_id = $1) and status = 'reserved'`,
      [swapId],
    );
    await c.query(
      `update swaps set status = 'cancelled', closed_at = now(), closed_by = $2, close_reason = $3,
              version = version + 1, updated_at = now() where id = $1`,
      [swapId, viewerId, reason],
    );
    await event(c, swapId, viewerId, "cancelled", { reason });
  });
}

/**
 * A participant confirms they received their item. When both have confirmed, the swap completes:
 * each side receives a clone of the item it got (a draft, with provenance and copied photos) and the
 * originals become swapped (design §6.1).
 */
export async function confirmReceived(ctx: SwapCtx, viewerId: string, swapId: string): Promise<void> {
  await inTx(ctx.db, async (c) => {
    const swap = await lockSwap(c, swapId);
    if (!swap || (swap.requester_id !== viewerId && swap.recipient_id !== viewerId)) throw new DomainError("NOT_FOUND", "Swap not found.");
    if (swap.status !== "accepted") throw new DomainError("SWAP_INVALID_TRANSITION", `A ${swap.status} swap can't be confirmed.`);

    const already = await c.query<{ confirmed_received_at: Date | null }>(
      "select confirmed_received_at from swap_participants where swap_id = $1 and user_id = $2 for update",
      [swapId, viewerId],
    );
    if (!already.rows[0]?.confirmed_received_at) {
      await c.query("update swap_participants set confirmed_received_at = now() where swap_id = $1 and user_id = $2", [swapId, viewerId]);
      await event(c, swapId, viewerId, "received_confirmed");
    }

    const both = await c.query<{ n: string }>(
      "select count(*)::text as n from swap_participants where swap_id = $1 and confirmed_received_at is not null",
      [swapId],
    );
    if (Number(both.rows[0]!.n) < 2) return;

    const transfers = await c.query<{ item_id: string; to_user_id: string }>(
      "select item_id, to_user_id from swap_items where swap_id = $1",
      [swapId],
    );
    for (const t of transfers.rows) {
      const cloneId = await cloneItemTo(c, ctx, t.item_id, t.to_user_id);
      await c.query("update items set status = 'swapped', version = version + 1, updated_at = now() where id = $1", [t.item_id]);
      await c.query("update swap_items set resulting_item_id = $3 where swap_id = $1 and item_id = $2", [swapId, t.item_id, cloneId]);
    }
    await c.query(
      `update swaps set status = 'completed', completed_at = now(), closed_at = now(), version = version + 1, updated_at = now()
        where id = $1`,
      [swapId],
    );
    await event(c, swapId, viewerId, "completed");
  });
}

/** Copies an item into another user's library as a draft, with its ready photos copied in storage. */
async function cloneItemTo(c: Client, ctx: SwapCtx, sourceItemId: string, newOwnerId: string): Promise<string> {
  const src = await c.query<{
    id: string;
    category_id: string | null;
    title: string | null;
    description: string | null;
    attributes: Record<string, unknown>;
    condition: string | null;
    fulfillment_options: string[];
  }>("select id, category_id, title, description, attributes, condition, fulfillment_options from items where id = $1", [sourceItemId]);
  const s = src.rows[0]!;
  const created = await c.query<{ id: string }>(
    `insert into items (owner_id, category_id, title, description, attributes, condition, source, status, fulfillment_options, origin_item_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, 'swap_received', 'draft', $7, $8) returning id`,
    [newOwnerId, s.category_id, s.title, s.description, JSON.stringify(s.attributes), s.condition, s.fulfillment_options, s.id],
  );
  const cloneId = created.rows[0]!.id;

  const media = await c.query<{ id: string; original_key: string; variants: StoredVariants | null; mime: string; bytes: number; width: number | null; height: number | null; position: number }>(
    "select id, original_key, variants, mime, bytes, width, height, position from item_media where item_id = $1 and status = 'ready' order by position",
    [sourceItemId],
  );
  for (const m of media.rows) {
    const newMediaId = randomUUID();
    const newOriginal = originalKey(cloneId, newMediaId);
    await ctx.store.copy(ctx.privateBucket, m.original_key, newOriginal);
    const newVariants: StoredVariants = {};
    for (const kind of ["thumb", "card", "full"] as const) {
      const v = m.variants?.[kind];
      if (!v) continue;
      const key = variantKey(cloneId, newMediaId, kind);
      await ctx.store.copy(ctx.publicBucket, v.key, key);
      newVariants[kind] = { key, w: v.w, h: v.h };
    }
    await c.query(
      `insert into item_media (id, item_id, status, original_key, variants, mime, bytes, width, height, position)
       values ($1, $2, 'ready', $3, $4::jsonb, $5, $6, $7, $8, $9)`,
      [newMediaId, cloneId, newOriginal, JSON.stringify(newVariants), m.mime, m.bytes, m.width, m.height, m.position],
    );
  }
  return cloneId;
}

/** Cron job swaps-expire (design §8). Expires pending swaps past their deadline. Idempotent. */
export async function expireDueSwaps(db: pg.Pool): Promise<number> {
  const { rowCount } = await db.query(
    `update swaps set status = 'expired', closed_at = now(), close_reason = 'expired', version = version + 1, updated_at = now()
      where status = 'pending' and expires_at <= now()`,
  );
  return rowCount ?? 0;
}

/** Test mode only: moves a swap's deadline into the past so expiry can be exercised. */
export async function backdateSwap(db: pg.Pool, swapId: string): Promise<boolean> {
  const { rowCount } = await db.query("update swaps set expires_at = now() - interval '1 second' where id = $1", [swapId]);
  return (rowCount ?? 0) > 0;
}

/** Output for one swap, as seen by a participant. Null when the viewer isn't a participant. */
export async function swapView(ctx: SwapCtx, viewerId: string, swapId: string) {
  const { rows } = await ctx.db.query<SwapRow & { requester_name: string | null; recipient_name: string | null }>(
    `select s.${SWAP_COLUMNS.split(",").map((c) => c.trim()).join(", s.")},
            pr.display_name as requester_name, pe.display_name as recipient_name
       from swaps s
       left join profiles pr on pr.user_id = s.requester_id
       left join profiles pe on pe.user_id = s.recipient_id
      where s.id = $1 and (s.requester_id = $2 or s.recipient_id = $2)`,
    [swapId, viewerId],
  );
  const row = rows[0];
  if (!row) return null;
  return toSwapOutput(ctx, row, viewerId);
}

type ViewRow = SwapRow & { requester_name: string | null; recipient_name: string | null };

export async function toSwapOutput(ctx: SwapCtx, row: ViewRow, viewerId: string) {
  const parts = await ctx.db.query<{ user_id: string; role: string; confirmed_received_at: Date | null }>(
    "select user_id, role, confirmed_received_at from swap_participants where swap_id = $1",
    [row.id],
  );
  const items = await ctx.db.query<{ from_user_id: string; to_user_id: string; snapshot: { cover_variants: StoredVariants | null; title: string | null; category: unknown; condition: string | null; item_id: string } }>(
    "select from_user_id, to_user_id, snapshot from swap_items where swap_id = $1",
    [row.id],
  );
  const convo = await ctx.db.query<{ id: string }>("select id from conversations where swap_id = $1", [row.id]);
  const side = (userId: string, name: string | null, role: "requester" | "recipient") => {
    const p = parts.rows.find((x) => x.user_id === userId);
    return {
      user: { id: userId, display_name: name },
      items: items.rows
        .filter((i) => i.from_user_id === userId)
        .map((i) => ({
          id: i.snapshot.item_id,
          title: i.snapshot.title,
          category: i.snapshot.category,
          condition: i.snapshot.condition,
          cover: { urls: mediaUrls(ctx.mediaBaseUrl, ctx.publicBucket, i.snapshot.cover_variants) },
        })),
      confirmed_received_at: p?.confirmed_received_at?.toISOString() ?? null,
      role,
    };
  };
  return {
    id: row.id,
    status: row.status,
    fulfillment_method: row.fulfillment_method,
    note: row.note,
    expires_at: row.expires_at.toISOString(),
    accepted_at: row.accepted_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    closed_at: row.closed_at?.toISOString() ?? null,
    close_reason: row.close_reason,
    requester: side(row.requester_id, row.requester_name, "requester"),
    recipient: side(row.recipient_id, row.recipient_name, "recipient"),
    my_role: viewerId === row.requester_id ? "requester" : "recipient",
    conversation_id: convo.rows[0]?.id ?? null,
    version: row.version,
    created_at: row.created_at.toISOString(),
  };
}

export async function swapEvents(db: pg.Pool, swapId: string) {
  const { rows } = await db.query<{ id: string; type: string; actor_id: string | null; payload: unknown; created_at: Date }>(
    "select id, type, actor_id, payload, created_at from swap_events where swap_id = $1 order by id",
    [swapId],
  );
  return rows.map((r) => ({ id: r.id, type: r.type, actor_id: r.actor_id, payload: r.payload, created_at: r.created_at.toISOString() }));
}
