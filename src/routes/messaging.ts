import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type pg from "pg";
import type { Auth } from "../auth/auth.js";
import type { Realtime } from "../adapters/realtime.js";
import type { Logger } from "../logging/logger.js";
import { DomainError } from "../errors/domain-error.js";
import { requireUser } from "../http/session.js";
import { COMMON_ERRORS, problemResponse } from "../http/schemas.js";
import type { AppEnv } from "../http/app.js";
import { decodeCursor, encodeCursor } from "../catalog/cursor.js";
import {
  conversationSummary,
  listConversations,
  listMessages,
  markRead,
  messageOut,
  realtimeToken,
  sendMessage,
  setMute,
  type MessagingCtx,
} from "../messaging/service.js";

export type MessagingDeps = MessagingCtx & { auth: Pick<Auth, "api"> };

const AUTH = { 401: problemResponse("Authentication required") } as const;
const Obj = z.record(z.string(), z.unknown());
const Page = z.object({ data: z.array(Obj), next_cursor: z.string().nullable() });
const idParam = z.object({ id: z.string().uuid() });

const listRoute = createRoute({
  method: "get",
  path: "/v1/conversations",
  operationId: "listConversations",
  tags: ["Messaging"],
  summary: "My conversations",
  description: "Most recent activity first. Each has its last message and unread count.",
  request: { query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }) },
  responses: { 200: { description: "Page of conversations", content: { "application/json": { schema: Page } } }, ...AUTH, ...COMMON_ERRORS },
});

const detailRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{id}",
  operationId: "getConversation",
  tags: ["Messaging"],
  summary: "A conversation",
  description: "Summary for one conversation: the swap, the other person, the last message and unread count.",
  request: { params: idParam },
  responses: { 200: { description: "Conversation", content: { "application/json": { schema: Obj } } }, ...AUTH, ...COMMON_ERRORS },
});

const messagesRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{id}/messages",
  operationId: "listMessages",
  tags: ["Messaging"],
  summary: "Messages, newest first",
  description: "Pass next_cursor as `before` to load older messages.",
  request: {
    params: idParam,
    query: z.object({ before: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  },
  responses: { 200: { description: "Page of messages", content: { "application/json": { schema: Page } } }, ...AUTH, ...COMMON_ERRORS },
});

const sendRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/messages",
  operationId: "sendMessage",
  tags: ["Messaging"],
  summary: "Send a message",
  description: "Open while the swap is pending, accepted or disputed. Repeating a client_message_id returns the original message.",
  request: {
    params: idParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            client_message_id: z.string().min(1).max(64),
            kind: z.literal("text").default("text"),
            body: z.string().min(1).max(4000),
          }),
        },
      },
    },
  },
  responses: { 201: { description: "Sent", content: { "application/json": { schema: Obj } } }, ...AUTH, ...COMMON_ERRORS },
});

const readRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/read",
  operationId: "markConversationRead",
  tags: ["Messaging"],
  summary: "Mark read up to a message",
  description: "Clears unread messages up to and including the given message.",
  request: { params: idParam, body: { required: true, content: { "application/json": { schema: z.object({ message_id: z.string().uuid() }) } } } },
  responses: { 204: { description: "Marked read" }, ...AUTH, ...COMMON_ERRORS },
});

const muteRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/mute",
  operationId: "muteConversation",
  tags: ["Messaging"],
  summary: "Mute notifications for a conversation",
  description: "Set until to a time to mute, or null to unmute.",
  request: {
    params: idParam,
    body: { required: true, content: { "application/json": { schema: z.object({ until: z.string().datetime().nullable() }) } } },
  },
  responses: { 204: { description: "Muted or unmuted" }, ...AUTH, ...COMMON_ERRORS },
});

const tokenRoute = createRoute({
  method: "get",
  path: "/v1/realtime/token",
  operationId: "getRealtimeToken",
  tags: ["Messaging"],
  summary: "Live connection token",
  description: "A short-lived Ably token request. It only allows your own conversations and your user channel.",
  responses: {
    200: { description: "Token request", content: { "application/json": { schema: z.object({ token_request: Obj, expires_at: z.string() }) } } },
    503: problemResponse("Live delivery is not configured"),
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

const notificationsRoute = createRoute({
  method: "get",
  path: "/v1/notifications",
  operationId: "listNotifications",
  tags: ["Messaging"],
  summary: "In-app notifications",
  description: "Newest first. unread_count is the total unread across all notifications.",
  request: {
    query: z.object({ unread_only: z.enum(["true", "false"]).default("false"), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  },
  responses: {
    200: {
      description: "Page of notifications",
      content: { "application/json": { schema: z.object({ data: z.array(Obj), next_cursor: z.string().nullable(), unread_count: z.number().int() }) } },
    },
    ...AUTH,
    ...COMMON_ERRORS,
  },
});

const markNotificationsRoute = createRoute({
  method: "post",
  path: "/v1/notifications/read",
  operationId: "markNotificationsRead",
  tags: ["Messaging"],
  summary: "Mark notifications read",
  description: "Pass ids to mark specific notifications, or all: true to mark everything.",
  request: {
    body: { required: true, content: { "application/json": { schema: z.object({ ids: z.array(z.string().uuid()).optional(), all: z.boolean().optional() }) } } },
  },
  responses: { 204: { description: "Marked read" }, ...AUTH, ...COMMON_ERRORS },
});

export function registerMessagingRoutes(app: OpenAPIHono<AppEnv>, deps: MessagingDeps) {
  const { db, auth, realtime } = deps;

  app.openapi(listRoute, async (c) => {
    const user = await requireUser(auth, c);
    const q = c.req.valid("query");
    const cur = decodeCursor(q.cursor);
    return c.json(await listConversations(db, user.id, cur, q.limit), 200);
  });

  app.openapi(detailRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const summary = await conversationSummary(db, user.id, id);
    if (!summary) throw new DomainError("NOT_FOUND", "Conversation not found.");
    return c.json(summary as Record<string, unknown>, 200);
  });

  app.openapi(messagesRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    return c.json(await listMessages(db, user.id, id, q.before, q.limit), 200);
  });

  app.openapi(sendRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const message = await sendMessage(deps, user.id, id, { client_message_id: body.client_message_id, body: body.body });
    return c.json(message as Record<string, unknown>, 201);
  });

  app.openapi(readRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const { message_id } = c.req.valid("json");
    await markRead(db, user.id, id, message_id);
    return c.body(null, 204);
  });

  app.openapi(muteRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const { until } = c.req.valid("json");
    await setMute(db, user.id, id, until ? new Date(until) : null);
    return c.body(null, 204);
  });

  app.openapi(tokenRoute, async (c) => {
    const user = await requireUser(auth, c);
    if (!realtime.enabled) throw new DomainError("DEPENDENCY_UNAVAILABLE", "Live delivery is not configured.");
    const token_request = await realtimeToken(deps, user.id);
    return c.json({ token_request, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }, 200);
  });

  app.openapi(notificationsRoute, async (c) => {
    const user = await requireUser(auth, c);
    const q = c.req.valid("query");
    const cur = decodeCursor(q.cursor);
    const { rows } = await db.query<{ id: string; type: string; payload: unknown; read_at: Date | null; created_at: Date }>(
      `select id, type, payload, read_at, created_at from notifications
        where user_id = $1 and ($2::boolean = false or read_at is null)
          and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::uuid))
        order by created_at desc, id desc limit $5`,
      [user.id, q.unread_only === "true", cur?.t ?? null, cur?.id ?? null, q.limit + 1],
    );
    const unread = await db.query<{ n: string }>("select count(*)::text as n from notifications where user_id = $1 and read_at is null", [user.id]);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const data = page.map((n) => ({ id: n.id, type: n.type, payload: n.payload, read_at: n.read_at?.toISOString() ?? null, created_at: n.created_at.toISOString() }));
    return c.json(
      { data, next_cursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null, unread_count: Number(unread.rows[0]!.n) },
      200,
    );
  });

  app.openapi(markNotificationsRoute, async (c) => {
    const user = await requireUser(auth, c);
    const body = c.req.valid("json");
    if (body.all) {
      await db.query("update notifications set read_at = now() where user_id = $1 and read_at is null", [user.id]);
    } else if (body.ids && body.ids.length > 0) {
      await db.query("update notifications set read_at = now() where user_id = $1 and id = any($2::uuid[]) and read_at is null", [user.id, body.ids]);
    }
    return c.body(null, 204);
  });
}

export type { Realtime, Logger };
export { messageOut };
