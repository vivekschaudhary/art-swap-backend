/**
 * M2 Identity scenarios (docs/v1-design.md §7.3, §7.4, §14, §16.4).
 *
 * Covered here: email-OTP sign-in end to end (via Mailpit), session as cookie and as bearer token,
 * profile creation, location privacy, blocks, and problem+json on auth failures.
 *
 * Pending, not faked: Google OAuth and passkey ceremonies need a real browser with a WebAuthn
 * virtual authenticator. They're listed as todo below and run in the browser suite (M2b).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { send, type CapturedResponse } from "../../lib/http.ts";
import { formatMismatches, match } from "../../lib/match.ts";
import { extractOtp, waitForEmailText } from "../../lib/mailpit.ts";
import { waitForLogs } from "../../lib/logs.ts";

const run = Date.now().toString(36);
const emailFor = (name: string) => `m2-${name}-${run}@example.test`;

/** Signs a user in with email OTP and returns the session token and cookie. */
async function signIn(email: string): Promise<{ token: string; cookie: string; userId: string }> {
  const sent = await send({
    method: "POST",
    path: "/v1/auth/email-otp/send-verification-otp",
    body: { email, type: "sign-in" },
  });
  expect(sent.status, sent.text).toBe(200);

  const otp = extractOtp(await waitForEmailText(email));
  const res = await send({
    method: "POST",
    path: "/v1/auth/sign-in/email-otp",
    body: { email, otp },
  });
  expect(res.status, res.text).toBe(200);

  const token = res.headers["set-auth-token"];
  const cookie = res.headers["set-cookie"];
  expect(token, "bearer token header missing").toBeTruthy();
  expect(cookie, "session cookie missing").toBeTruthy();
  const userId = (res.json as { user: { id: string } }).user.id;
  return { token: token!, cookie: cookie!.split(";")[0]!, userId };
}

function expectProblem(res: CapturedResponse, status: number, code: string) {
  expect(res.status, res.text).toBe(status);
  expect(res.contentType).toMatch(/^application\/problem\+json/);
  const problems = match({ code, status, request_id: "$nonempty" }, res.json);
  expect(problems, formatMismatches(problems)).toEqual([]);
}

describe("M2 authentication required", () => {
  it("GET /v1/me without credentials → 401 UNAUTHENTICATED", async () => {
    const res = await send({ method: "GET", path: "/v1/me" });
    expectProblem(res, 401, "UNAUTHENTICATED");
  });

  it("an invalid bearer token → 401 UNAUTHENTICATED", async () => {
    const res = await send({ method: "GET", path: "/v1/me", headers: { authorization: "Bearer not-a-real-token" } });
    expectProblem(res, 401, "UNAUTHENTICATED");
  });
});

describe("M2 email OTP sign-in", () => {
  it("a wrong code → 401 problem+json, not a raw Better Auth body", async () => {
    const email = emailFor("wrong-code");
    await send({ method: "POST", path: "/v1/auth/email-otp/send-verification-otp", body: { email, type: "sign-in" } });
    await waitForEmailText(email);
    const res = await send({ method: "POST", path: "/v1/auth/sign-in/email-otp", body: { email, otp: "000000" } });
    expectProblem(res, 401, "UNAUTHENTICATED");
  });

  it("a valid code signs in and returns a session as cookie and as bearer token", async () => {
    const session = await signIn(emailFor("session"));
    expect(session.token.length).toBeGreaterThan(20);
    expect(session.cookie).toMatch(/=/);
  });

  it("the OTP never appears in the API logs", async () => {
    const email = emailFor("log-redaction");
    await send({ method: "POST", path: "/v1/auth/email-otp/send-verification-otp", body: { email, type: "sign-in" } });
    const otp = extractOtp(await waitForEmailText(email));
    const res = await send({ method: "POST", path: "/v1/auth/sign-in/email-otp", body: { email, otp } });
    const lines = await waitForLogs(res.headers["x-request-id"]!, (ls) => ls.length > 0);
    expect(JSON.stringify(lines)).not.toContain(otp);
  });
});

describe("M2 profile and sessions", () => {
  let cookieSession: { token: string; cookie: string; userId: string };
  let otherSession: { token: string; cookie: string; userId: string };

  beforeAll(async () => {
    cookieSession = await signIn(emailFor("profile"));
    otherSession = await signIn(emailFor("other"));
  });

  it("GET /v1/me creates the profile on first call (cookie session)", async () => {
    const res = await send({ method: "GET", path: "/v1/me", headers: { cookie: cookieSession.cookie } });
    expect(res.status, res.text).toBe(200);
    const problems = match(
      { id: cookieSession.userId, onboarded: false, display_name: "$any", has_passkey: false, email: emailFor("profile") },
      res.json,
    );
    expect(problems, formatMismatches(problems)).toEqual([]);
  });

  it("the same profile is returned with the bearer token", async () => {
    const res = await send({ method: "GET", path: "/v1/me", headers: { authorization: `Bearer ${cookieSession.token}` } });
    expect(res.status).toBe(200);
    expect((res.json as { id: string }).id).toBe(cookieSession.userId);
  });

  it("PUT /v1/me/location accepts coordinates but never echoes them", async () => {
    const res = await send({
      method: "PUT",
      path: "/v1/me/location",
      headers: { authorization: `Bearer ${cookieSession.token}` },
      body: { lat: 37.7749, lng: -122.4194, search_radius_km: 25 },
    });
    expect(res.status, res.text).toBe(200);
    // No coordinate keys and no exact coordinate values. The "location" object itself is allowed.
    expect(res.text).not.toMatch(/"lat"|"lng"|37\.77|122\.41/);
    const problems = match({ location: { area_label: "$string", search_radius_km: 25 } }, res.json);
    expect(problems, formatMismatches(problems)).toEqual([]);
  });

  it("GET /v1/me after setting location still exposes no coordinates", async () => {
    const res = await send({ method: "GET", path: "/v1/me", headers: { authorization: `Bearer ${cookieSession.token}` } });
    expect(res.text).not.toMatch(/"lat"|"lng"|37\.77|122\.41/);
  });

  it("a blocked user's profile → 404 NOT_FOUND", async () => {
    const blocked = await send({
      method: "POST",
      path: "/v1/blocks",
      headers: { authorization: `Bearer ${cookieSession.token}` },
      body: { user_id: otherSession.userId },
    });
    expect(blocked.status, blocked.text).toBe(204);

    const res = await send({
      method: "GET",
      path: `/v1/users/${otherSession.userId}`,
      headers: { authorization: `Bearer ${cookieSession.token}` },
    });
    expectProblem(res, 404, "NOT_FOUND");

    // The block is symmetric in effect (§5.2): the blocked user can't see the blocker either.
    const reverse = await send({
      method: "GET",
      path: `/v1/users/${cookieSession.userId}`,
      headers: { authorization: `Bearer ${otherSession.token}` },
    });
    expectProblem(reverse, 404, "NOT_FOUND");
  });
});

describe("M2 pending browser-driven flows (M2b)", () => {
  it.todo("Google sign-in: web redirect flow completes and creates a user");
  it.todo("Google sign-in: native ID token exchange via POST /v1/auth/sign-in/social");
  it.todo("passkey: register with a WebAuthn virtual authenticator, then sign in with it (discoverable credential)");
  it.todo("passkey: list and delete a registered passkey");
  it.todo("passkey: GET /v1/me reports has_passkey true after registration");
});
