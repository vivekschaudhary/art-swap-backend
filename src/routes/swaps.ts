import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type pg from "pg";
import type { Auth } from "../auth/auth.js";
import type { ObjectStore } from "../adapters/object-store.js";
import { DomainError } from "../errors/domain-error.js";
import { buildProblem } from "../errors/problem.js";
import { requireUser } from "../http/session.js";
import { withIdempotency } from "../http/idempotency.js";
import { COMMON_ERRORS, problemResponse } from "../http/schemas.js";
import type { AppEnv } from "../http/app.js";
import { decodeCursor, encodeCursor } from "../catalog/cursor.js";
import {
  acceptSwap,
  cancelSwap,
  closePending,
  confirmReceived,
  createSwap,
  swapEvents,
  swapView,
  toSwapOutput,
  type SwapCtx,
} from "../swaps/service.js";

export type SwapDeps = SwapCtx & { auth: Pick<Auth, "api"> };

const AUTH = { 401: problemResponse("Authentication required") } as const;
const SwapSchema = z.record(z.string(), z.unknown()).openapi("Swap");
const SwapPage = z.object({ data: z.array(SwapSchema), next_cursor: z.string().nullable() });

const ListQuery = z.object({
  role: z.enum(["incoming", "outgoing", "all"]).default("all"),
  status: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const createRouteDef = createRoute({
  method: "post",
  path: "/v1/swaps",
  operationId: "createSwap",
  tags: ["Swaps"],
  summary: "Request a swap",
  description: "Offers one of your items for another person's item. Send Idempotency-Key to make retries safe.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            requested_item_id: z.string().uuid(),
            offered_item_id: z.string().uuid(),
            fulfillment_method: z.enum(["local_pickup", "shipping", "either"]).default("local_pickup"),
            note: z.string().max(500).optional(),
          }),
        },
      },
    },
  },
  responses: { 201: { description: "Swap requested", content: { "application/json": { schema: SwapSchema } } }, ...AUTH, ...COMMON_ERRORS },
});

const listRoute = createRoute({
  method: "get",
  path: "/v1/swaps",
  operationId: "listSwaps",
  tags: ["Swaps"],
  summary: "My swaps",
  description: "Swaps you are part of. Filter with role=incoming|outgoing|all and status=pending,accepted,… . Newest first.",
  request: { query: ListQuery },
  responses: { 200: { description: "Page of swaps", content: { "application/json": { schema: SwapPage } } }, ...AUTH, ...COMMON_ERRORS },
});

const detailRoute = createRoute({
  method: "get",
  path: "/v1/swaps/{id}",
  operationId: "getSwap",
  tags: ["Swaps"],
  summary: "A swap and its timeline",
  description: "Returns the swap and its events in order. Only the two participants can see it.",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { 200: { description: "Swap", content: { "application/json": { schema: SwapSchema } } }, ...AUTH, ...COMMON_ERRORS },
});

const actionResponse = { 200: { description: "Updated swap", content: { "application/json": { schema: SwapSchema } } } };
const conflictResponse = { 412: problemResponse("Version conflict; body includes current") };

const acceptRoute = createRoute({
  method: "post",
  path: "/v1/swaps/{id}/accept",
  operationId: "acceptSwap",
  tags: ["Swaps"],
  summary: "Accept a swap (recipient)",
  description: "Reserves both items and invalidates other pending requests for them. Send If-Match with the version you saw.",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { ...actionResponse, ...conflictResponse, ...AUTH, ...COMMON_ERRORS },
});

const declineRoute = createRoute({
  method: "post",
  path: "/v1/swaps/{id}/decline",
  operationId: "declineSwap",
  tags: ["Swaps"],
  summary: "Decline a swap (recipient)",
  description: "Only while the swap is pending. The requester is not notified in this version (notifications arrive in M6).",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { ...actionResponse, ...AUTH, ...COMMON_ERRORS },
});

const withdrawRoute = createRoute({
  method: "post",
  path: "/v1/swaps/{id}/withdraw",
  operationId: "withdrawSwap",
  tags: ["Swaps"],
  summary: "Withdraw a request (requester)",
  description: "Only while the swap is pending.",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { ...actionResponse, ...AUTH, ...COMMON_ERRORS },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/v1/swaps/{id}/cancel",
  operationId: "cancelSwap",
  tags: ["Swaps"],
  summary: "Cancel an accepted swap",
  description: "Either side. A reason is required. Items become available again.",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { required: true, content: { "application/json": { schema: z.object({ reason: z.string().min(1).max(500) }) } } },
  },
  responses: { ...actionResponse, ...AUTH, ...COMMON_ERRORS },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/v1/swaps/{id}/confirm-received",
  operationId: "confirmSwapReceived",
  tags: ["Swaps"],
  summary: "Confirm you received your item",
  description: "When both sides confirm, the swap completes and each side receives a copy of the item it got.",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { ...actionResponse, ...AUTH, ...COMMON_ERRORS },
});

const historyRoute = createRoute({
  method: "get",
  path: "/v1/me/history",
  operationId: "listMyHistory",
  tags: ["Swaps"],
  summary: "Completed swaps",
  description: "Swaps both sides confirmed, newest first.",
  request: { query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }) },
  responses: { 200: { description: "Page of completed swaps", content: { "application/json": { schema: SwapPage } } }, ...AUTH, ...COMMON_ERRORS },
});

function parseIfMatch(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.replace(/"/g, ""));
  if (!Number.isInteger(n)) throw new DomainError("VALIDATION_FAILED", "If-Match must be a version number.");
  return n;
}

export function registerSwapRoutes(app: OpenAPIHono<AppEnv>, deps: SwapDeps) {
  const { db, auth } = deps;

  app.openapi(createRouteDef, async (c) => {
    const user = await requireUser(auth, c);
    const body = c.req.valid("json");
    if (body.fulfillment_method !== "local_pickup") {
      throw new DomainError("FULFILLMENT_NOT_SUPPORTED", "Only local pickup is available in this version.", [
        { field: "fulfillment_method", message: "only local_pickup is supported" },
      ]);
    }
    const result = await withIdempotency(db, { userId: user.id, key: c.req.header("idempotency-key"), route: "POST /v1/swaps", body }, async () => {
      const swapId = await createSwap(deps, user.id, body);
      const view = await swapView(deps, user.id, swapId);
      return { status: 201, body: view };
    });
    return c.json(result.body as Record<string, unknown>, result.status as 201);
  });

  app.openapi(listRoute, async (c) => {
    const user = await requireUser(auth, c);
    const q = c.req.valid("query");
    const cur = decodeCursor(q.cursor);
    const roleClause =
      q.role === "incoming" ? "s.recipient_id = $1" : q.role === "outgoing" ? "s.requester_id = $1" : "(s.requester_id = $1 or s.recipient_id = $1)";
    const statuses = q.status ? q.status.split(",").map((x) => x.trim()).filter(Boolean) : null;
    const params: unknown[] = [user.id, statuses, cur?.t ?? null, cur?.id ?? null, q.limit + 1];
    const { rows } = await db.query<{ id: string; created_at: Date }>(
      `select s.id, s.created_at from swaps s
        where ${roleClause}
          and ($2::text[] is null or s.status = any($2::text[]))
          and ($3::timestamptz is null or (s.created_at, s.id) < ($3::timestamptz, $4::uuid))
        order by s.created_at desc, s.id desc limit $5`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const data = [];
    for (const r of page) {
      const view = await swapView(deps, user.id, r.id);
      if (view) data.push(view);
    }
    const last = page[page.length - 1];
    return c.json({ data, next_cursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }, 200);
  });

  app.openapi(detailRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const view = await swapView(deps, user.id, id);
    if (!view) throw new DomainError("NOT_FOUND", "Swap not found.");
    return c.json({ ...view, events: await swapEvents(db, id) } as Record<string, unknown>, 200);
  });

  app.openapi(acceptRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const result = await acceptSwap(deps, user.id, id, parseIfMatch(c.req.header("if-match")));
    if (!result.ok) {
      const current = await swapView(deps, user.id, id);
      const body = { ...buildProblem("VERSION_CONFLICT", "This swap changed. Reload and try again.", c.get("requestId")), current };
      // The 412 body is problem+json with a `current` field, which the typed response schema does not describe.
      return new Response(JSON.stringify(body), { status: 412, headers: { "content-type": "application/problem+json" } }) as never;
    }
    return c.json((await swapView(deps, user.id, id)) as Record<string, unknown>, 200);
  });

  app.openapi(declineRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    await closePending(deps, user.id, id, "declined");
    return c.json((await swapView(deps, user.id, id)) as Record<string, unknown>, 200);
  });

  app.openapi(withdrawRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    await closePending(deps, user.id, id, "withdrawn");
    return c.json((await swapView(deps, user.id, id)) as Record<string, unknown>, 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    await cancelSwap(deps, user.id, id, reason);
    return c.json((await swapView(deps, user.id, id)) as Record<string, unknown>, 200);
  });

  app.openapi(confirmRoute, async (c) => {
    const user = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    await confirmReceived(deps, user.id, id);
    return c.json((await swapView(deps, user.id, id)) as Record<string, unknown>, 200);
  });

  app.openapi(historyRoute, async (c) => {
    const user = await requireUser(auth, c);
    const q = c.req.valid("query");
    const cur = decodeCursor(q.cursor);
    const { rows } = await db.query<{ id: string; created_at: Date; completed_at: Date }>(
      `select s.id, s.created_at, s.completed_at from swaps s
        where s.status = 'completed' and (s.requester_id = $1 or s.recipient_id = $1)
          and ($2::timestamptz is null or (s.created_at, s.id) < ($2::timestamptz, $3::uuid))
        order by s.created_at desc, s.id desc limit $4`,
      [user.id, cur?.t ?? null, cur?.id ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const data = [];
    for (const r of page) {
      const view = await swapView(deps, user.id, r.id);
      if (view) data.push(view);
    }
    const last = page[page.length - 1];
    return c.json({ data, next_cursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }, 200);
  });
}

export type { ObjectStore, SwapCtx };
export { toSwapOutput };
