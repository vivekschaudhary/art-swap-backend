/**
 * M6 Messaging scenarios (docs/v1-design.md §5.6, §7.9, §7.10, §16.4).
 *
 * Contract details (also recorded in the design doc):
 * - A swap has one conversation, created when the swap is requested. Swap.conversation_id is set.
 * - Messages can be sent while the swap is pending, accepted or disputed. Otherwise the conversation
 *   is closed: 409 CONVERSATION_CLOSED.
 * - POST messages is idempotent on client_message_id: a repeat returns the original message.
 * - Live delivery uses Ably. The server publishes each new message to the conversation's channel.
 *   Clients get a short-lived token from GET /v1/realtime/token, limited to their own channels.
 * - The live check reads Ably channel history with EVALS_ABLY_KEY. It is skipped when that key isn't set.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { send, type CapturedResponse } from "../../lib/http.ts";
import { formatMismatches, match } from "../../lib/match.ts";
import { auth } from "../../lib/session.ts";
import { makeTrade, createSwap, swapOf, type Trade } from "../../lib/trade.ts";

const ABLY_KEY = process.env.EVALS_ABLY_KEY;
const newClientId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function expectProblem(res: CapturedResponse, status: number, code: string) {
  expect(res.status, res.text).toBe(status);
  expect(res.contentType).toMatch(/^application\/problem\+json/);
  const problems = match({ code, status, request_id: "$nonempty" }, res.json);
  expect(problems, formatMismatches(problems)).toEqual([]);
}

async function conversationFor(t: Trade): Promise<{ swapId: string; conversationId: string }> {
  const created = (await createSwap(t)).json as { id: string };
  const swap = (await send({ method: "GET", path: `/v1/swaps/${created.id}`, headers: auth(t.requester) })).json as { conversation_id: string | null };
  expect(swap.conversation_id, "a swap should have its conversation from the start").toEqual(expect.any(String));
  return { swapId: created.id, conversationId: swap.conversation_id! };
}

async function say(t: Trade, who: "requester" | "recipient", conversationId: string, body: string, clientId = newClientId()) {
  return send({
    method: "POST",
    path: `/v1/conversations/${conversationId}/messages`,
    headers: auth(who === "requester" ? t.requester : t.recipient),
    body: { client_message_id: clientId, kind: "text", body },
  });
}

describe("M6 conversations", () => {
  it("a new swap has a conversation visible to both sides", async () => {
    const t = await makeTrade("convo");
    const { conversationId } = await conversationFor(t);
    for (const who of [t.requester, t.recipient]) {
      const res = await send({ method: "GET", path: `/v1/conversations/${conversationId}`, headers: auth(who) });
      expect(res.status, res.text).toBe(200);
    }
  });

  it("a stranger can't read the conversation → 404 NOT_FOUND", async () => {
    const t = await makeTrade("convo-stranger");
    const { conversationId } = await conversationFor(t);
    const stranger = await makeTrade("stranger-of-convo");
    const res = await send({ method: "GET", path: `/v1/conversations/${conversationId}`, headers: auth(stranger.requester) });
    expectProblem(res, 404, "NOT_FOUND");
  });

  it("the list shows the conversation with its last message and unread count", async () => {
    const t = await makeTrade("list");
    const { conversationId } = await conversationFor(t);
    await say(t, "requester", conversationId, "Is the frame included?");
    const res = await send({ method: "GET", path: "/v1/conversations?limit=50", headers: auth(t.recipient) });
    expect(res.status).toBe(200);
    const row = (res.json as { data: { id: string; unread_count: number; last_message: { body: string } | null }[] }).data.find((c) => c.id === conversationId);
    expect(row, "the conversation should be listed").toBeDefined();
    expect(row!.last_message?.body).toBe("Is the frame included?");
    expect(row!.unread_count).toBeGreaterThanOrEqual(1);
  });
});

describe("M6 sending and reading", () => {
  let t: Trade;
  let conversationId: string;
  beforeAll(async () => {
    t = await makeTrade("messages");
    ({ conversationId } = await conversationFor(t));
  });

  it("a participant sends a text message and gets it back", async () => {
    const res = await say(t, "requester", conversationId, "Hi, is it still available?");
    expect(res.status, res.text).toBe(201);
    const body = res.json as { kind: string; body: string; sender_id: string; created_at: string };
    expect(body.kind).toBe("text");
    expect(body.body).toBe("Hi, is it still available?");
    expect(body.sender_id).toBe(t.requester.userId);
  });

  it("repeating a client_message_id returns the original message, not a duplicate", async () => {
    const clientId = newClientId();
    const first = await say(t, "recipient", conversationId, "Yes!", clientId);
    const second = await say(t, "recipient", conversationId, "Yes!", clientId);
    expect(first.status).toBe(201);
    expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id);
  });

  it("an empty or oversized message → 400 VALIDATION_FAILED", async () => {
    expectProblem(await say(t, "requester", conversationId, ""), 400, "VALIDATION_FAILED");
    expectProblem(await say(t, "requester", conversationId, "x".repeat(4001)), 400, "VALIDATION_FAILED");
  });

  it("messages come back newest first with a cursor for older ones", async () => {
    const res = await send({ method: "GET", path: `/v1/conversations/${conversationId}/messages?limit=2`, headers: auth(t.requester) });
    expect(res.status).toBe(200);
    const page = res.json as { data: { body: string }[]; next_cursor: string | null };
    expect(page.data.length).toBeLessThanOrEqual(2);
    expect(page.next_cursor, "more history should give a cursor").not.toBeNull();
  });

  it("marking read clears the unread count for the reader", async () => {
    await say(t, "requester", conversationId, "Are you free Saturday?");
    const messages = (await send({ method: "GET", path: `/v1/conversations/${conversationId}/messages?limit=1`, headers: auth(t.recipient) })).json as {
      data: { id: string }[];
    };
    const latest = messages.data[0]!.id;
    expect((await send({ method: "POST", path: `/v1/conversations/${conversationId}/read`, headers: auth(t.recipient), body: { message_id: latest } })).status).toBe(204);
    const list = (await send({ method: "GET", path: "/v1/conversations?limit=50", headers: auth(t.recipient) })).json as {
      data: { id: string; unread_count: number }[];
    };
    expect(list.data.find((c) => c.id === conversationId)!.unread_count).toBe(0);
  });

  it("a blocked participant can't send → 403 USER_BLOCKED", async () => {
    const blocked = await makeTrade("messages-blocked");
    const convo = await conversationFor(blocked);
    await send({ method: "POST", path: "/v1/blocks", headers: auth(blocked.recipient), body: { user_id: blocked.requester.userId } });
    expectProblem(await say(blocked, "requester", convo.conversationId, "Still there?"), 403, "USER_BLOCKED");
  });
});

describe("M6 closed conversations", () => {
  it("after a decline, the conversation is read-only → 409 CONVERSATION_CLOSED", async () => {
    const t = await makeTrade("closed-decline");
    const { swapId, conversationId } = await conversationFor(t);
    expect((await send({ method: "POST", path: `/v1/swaps/${swapId}/decline`, headers: auth(t.recipient), body: {} })).status).toBe(200);
    expectProblem(await say(t, "requester", conversationId, "Can we still talk?"), 409, "CONVERSATION_CLOSED");
  });

  it("messages stay open while a swap is accepted", async () => {
    const t = await makeTrade("open-accepted");
    const { swapId, conversationId } = await conversationFor(t);
    await send({ method: "POST", path: `/v1/swaps/${swapId}/accept`, headers: auth(t.recipient) });
    expect((await swapOf(t.requester, swapId)).status).toBe("accepted");
    expect((await say(t, "requester", conversationId, "Pickup at 6?")).status).toBe(201);
  });
});

describe("M6 realtime", () => {
  it("GET /v1/realtime/token returns a short-lived Ably token request", async () => {
    const t = await makeTrade("token");
    const res = await send({ method: "GET", path: "/v1/realtime/token", headers: auth(t.recipient) });
    expect(res.status, res.text).toBe(200);
    const body = res.json as { token_request: Record<string, unknown>; expires_at: string };
    expect(body.token_request).toHaveProperty("keyName");
    expect(body.token_request).toHaveProperty("mac");
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("the token only allows channels for the user's own conversations", async () => {
    const t = await makeTrade("token-scope");
    const res = await send({ method: "GET", path: "/v1/realtime/token", headers: auth(t.recipient) });
    const capability = JSON.parse(String((res.json as { token_request: { capability?: string } }).token_request.capability ?? "{}"));
    const keys = Object.keys(capability);
    expect(keys.every((k) => k.startsWith("conversation:") || k === `user:${t.recipient.userId}`)).toBe(true);
  });

  it.skipIf(!ABLY_KEY)("a sent message is published to the conversation channel", async () => {
    const t = await makeTrade("live");
    const { conversationId } = await conversationFor(t);
    const sent = await say(t, "requester", conversationId, "Live check");
    expect(sent.status).toBe(201);
    const channel = encodeURIComponent(`conversation:${conversationId}`);
    const auth64 = Buffer.from(ABLY_KEY!).toString("base64");
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const history = await fetch(`https://rest.ably.io/channels/${channel}/messages?limit=10`, { headers: { authorization: `Basic ${auth64}` } });
      const items = (await history.json()) as { data: string }[];
      found = JSON.stringify(items).includes("Live check");
      if (!found) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(found, "the message should appear on the Ably channel").toBe(true);
  });
});

describe("M6 notifications", () => {
  it("a new message creates an in-app notification for the other participant", async () => {
    const t = await makeTrade("notify");
    const { conversationId } = await conversationFor(t);
    await say(t, "requester", conversationId, "You there?");
    const res = await send({ method: "GET", path: "/v1/notifications?limit=50", headers: auth(t.recipient) });
    expect(res.status).toBe(200);
    expect((res.json as { data: { type: string }[] }).data.map((n) => n.type)).toContain("message.created");
  });

  it("the sender gets no notification for their own message", async () => {
    const t = await makeTrade("notify-self");
    const { conversationId } = await conversationFor(t);
    await say(t, "requester", conversationId, "Only me");
    const res = await send({ method: "GET", path: "/v1/notifications?limit=50", headers: auth(t.requester) });
    expect((res.json as { data: { type: string }[] }).data.map((n) => n.type)).not.toContain("message.created");
  });
});
