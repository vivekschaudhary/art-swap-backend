import type pg from "pg";
import type { Realtime } from "../adapters/realtime.js";
import type { Logger } from "../logging/logger.js";
import { DomainError } from "../errors/domain-error.js";
import { inTx } from "../swaps/service.js";

export type MessagingCtx = { db: pg.Pool; realtime: Realtime; logger: Logger };

/** Messages are open while a swap is pending, accepted or disputed (design §7.9). */
const OPEN_SWAP_STATES = ["pending", "accepted", "disputed"];

export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  kind: string;
  body: string | null;
  client_message_id: string | null;
  created_at: Date;
};

export const messageOut = (m: MessageRow) => ({
  id: m.id,
  conversation_id: m.conversation_id,
  sender_id: m.sender_id,
  kind: m.kind,
  body: m.body,
  attachments: [] as unknown[],
  client_message_id: m.client_message_id,
  created_at: m.created_at.toISOString(),
});

/** The conversation, if the viewer is one of its participants. Otherwise null (the caller returns 404). */
export async function participantConversation(db: pg.Pool, conversationId: string, viewerId: string) {
  const { rows } = await db.query<{ id: string; swap_id: string; swap_status: string; other_user_id: string }>(
    `select c.id, c.swap_id, s.status as swap_status,
            (select p.user_id from conversation_participants p where p.conversation_id = c.id and p.user_id <> $2) as other_user_id
       from conversations c
       join swaps s on s.id = c.swap_id
       join conversation_participants me on me.conversation_id = c.id and me.user_id = $2
      where c.id = $1`,
    [conversationId, viewerId],
  );
  return rows[0] ?? null;
}

async function blockedBetween(db: pg.Pool, a: string, b: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "select 1 from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)",
    [a, b],
  );
  return (rowCount ?? 0) > 0;
}

/** Sends a text message. A repeated client_message_id returns the original message. */
export async function sendMessage(ctx: MessagingCtx, viewerId: string, conversationId: string, input: { client_message_id: string; body: string }) {
  const convo = await participantConversation(ctx.db, conversationId, viewerId);
  if (!convo) throw new DomainError("NOT_FOUND", "Conversation not found.");
  if (convo.other_user_id && (await blockedBetween(ctx.db, viewerId, convo.other_user_id))) {
    throw new DomainError("USER_BLOCKED", "You can't message this person.");
  }
  if (!OPEN_SWAP_STATES.includes(convo.swap_status)) {
    throw new DomainError("CONVERSATION_CLOSED", "This conversation is closed because the swap ended.");
  }

  const message = await inTx(ctx.db, async (c) => {
    const inserted = await c.query<MessageRow>(
      `insert into messages (conversation_id, sender_id, kind, body, client_message_id)
       values ($1, $2, 'text', $3, $4)
       on conflict (conversation_id, sender_id, client_message_id) do nothing
       returning id, conversation_id, sender_id, kind, body, client_message_id, created_at`,
      [conversationId, viewerId, input.body, input.client_message_id],
    );
    if (inserted.rows[0] === undefined) {
      const existing = await c.query<MessageRow>(
        "select id, conversation_id, sender_id, kind, body, client_message_id, created_at from messages where conversation_id = $1 and sender_id = $2 and client_message_id = $3",
        [conversationId, viewerId, input.client_message_id],
      );
      return { row: existing.rows[0]!, created: false };
    }
    await c.query("update conversations set last_message_at = now() where id = $1", [conversationId]);
    if (convo.other_user_id) {
      await c.query("insert into notifications (user_id, type, payload) values ($1, 'message.created', $2::jsonb)", [
        convo.other_user_id,
        JSON.stringify({ conversation_id: conversationId, message_id: inserted.rows[0].id }),
      ]);
    }
    return { row: inserted.rows[0], created: true };
  });

  if (message.created) {
    // Best effort: the database has the message, so a failed publish is recovered from history.
    try {
      await ctx.realtime.publish(`conversation:${conversationId}`, "message.created", messageOut(message.row));
    } catch (err) {
      ctx.logger.warn({ conversation_id: conversationId, err: { name: (err as Error).name, message: (err as Error).message } }, "live publish failed");
    }
  }
  return messageOut(message.row);
}

/** Newest first. The cursor is the id of the oldest message on the page. */
export async function listMessages(db: pg.Pool, viewerId: string, conversationId: string, before: string | undefined, limit: number) {
  if (!(await participantConversation(db, conversationId, viewerId))) throw new DomainError("NOT_FOUND", "Conversation not found.");
  const { rows } = await db.query<MessageRow>(
    `select m.id, m.conversation_id, m.sender_id, m.kind, m.body, m.client_message_id, m.created_at
       from messages m
      where m.conversation_id = $1
        and ($2::uuid is null or (m.created_at, m.id) < (select created_at, id from messages where id = $2::uuid))
      order by m.created_at desc, m.id desc
      limit $3`,
    [conversationId, before ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { data: page.map(messageOut), next_cursor: rows.length > limit && last ? last.id : null };
}

export async function markRead(db: pg.Pool, viewerId: string, conversationId: string, messageId: string): Promise<void> {
  if (!(await participantConversation(db, conversationId, viewerId))) throw new DomainError("NOT_FOUND", "Conversation not found.");
  const { rowCount } = await db.query("select 1 from messages where id = $1 and conversation_id = $2", [messageId, conversationId]);
  if ((rowCount ?? 0) === 0) throw new DomainError("NOT_FOUND", "Message not found.");
  await db.query(
    "update conversation_participants set last_read_message_id = $3 where conversation_id = $1 and user_id = $2",
    [conversationId, viewerId, messageId],
  );
}

export async function setMute(db: pg.Pool, viewerId: string, conversationId: string, until: Date | null): Promise<void> {
  if (!(await participantConversation(db, conversationId, viewerId))) throw new DomainError("NOT_FOUND", "Conversation not found.");
  await db.query("update conversation_participants set muted_until = $3 where conversation_id = $1 and user_id = $2", [conversationId, viewerId, until]);
}

/** Conversation summary for the viewer: the last message and how many arrived since they last read. */
export async function conversationSummary(db: pg.Pool, viewerId: string, conversationId: string) {
  const { rows } = await db.query<{
    id: string;
    swap_id: string;
    swap_status: string;
    other_id: string | null;
    other_name: string | null;
    muted_until: Date | null;
    last_read_message_id: string | null;
    last_message_at: Date | null;
  }>(
    `select c.id, c.swap_id, s.status as swap_status,
            o.user_id as other_id, po.display_name as other_name,
            me.muted_until, me.last_read_message_id, c.last_message_at
       from conversations c
       join swaps s on s.id = c.swap_id
       join conversation_participants me on me.conversation_id = c.id and me.user_id = $2
       left join conversation_participants o on o.conversation_id = c.id and o.user_id <> $2
       left join profiles po on po.user_id = o.user_id
      where c.id = $1`,
    [conversationId, viewerId],
  );
  const c = rows[0];
  if (!c) return null;
  const last = await db.query<MessageRow>(
    "select id, conversation_id, sender_id, kind, body, client_message_id, created_at from messages where conversation_id = $1 order by created_at desc, id desc limit 1",
    [conversationId],
  );
  const unread = await db.query<{ n: string }>(
    `select count(*)::text as n from messages m
      where m.conversation_id = $1 and m.sender_id is distinct from $2
        and m.created_at > coalesce((select created_at from messages where id = $3), '-infinity'::timestamptz)`,
    [conversationId, viewerId, c.last_read_message_id],
  );
  return {
    id: c.id,
    swap: { id: c.swap_id, status: c.swap_status },
    other_user: c.other_id ? { id: c.other_id, display_name: c.other_name } : null,
    last_message: last.rows[0] ? messageOut(last.rows[0]) : null,
    unread_count: Number(unread.rows[0]!.n),
    muted_until: c.muted_until?.toISOString() ?? null,
  };
}

export async function listConversations(db: pg.Pool, viewerId: string, before: { t: string; id: string } | null, limit: number) {
  const { rows } = await db.query<{ id: string; sort_at: Date }>(
    `select c.id, coalesce(c.last_message_at, c.created_at) as sort_at
       from conversations c
       join conversation_participants me on me.conversation_id = c.id and me.user_id = $1
      where ($2::timestamptz is null or (coalesce(c.last_message_at, c.created_at), c.id) < ($2::timestamptz, $3::uuid))
      order by sort_at desc, c.id desc
      limit $4`,
    [viewerId, before?.t ?? null, before?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const data = [];
  for (const r of page) {
    const summary = await conversationSummary(db, viewerId, r.id);
    if (summary) data.push(summary);
  }
  const last = page[page.length - 1];
  return { data, next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ t: last.sort_at.toISOString(), id: last.id })).toString("base64url") : null };
}

/** A token request for live channels. Scoped to the user's own conversations and their own user channel. */
export async function realtimeToken(ctx: MessagingCtx, viewerId: string) {
  const { rows } = await ctx.db.query<{ id: string }>(
    `select c.id from conversations c join conversation_participants p on p.conversation_id = c.id and p.user_id = $1
      order by c.created_at desc limit 200`,
    [viewerId],
  );
  const capability: Record<string, string[]> = { [`user:${viewerId}`]: ["subscribe"] };
  for (const r of rows) capability[`conversation:${r.id}`] = ["subscribe", "history"];
  return ctx.realtime.tokenRequest(viewerId, capability);
}
