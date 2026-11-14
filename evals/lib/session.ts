import { send } from "./http.ts";
import { extractOtp, waitForEmailText } from "./mailpit.ts";
import { expect } from "vitest";

export type Session = { token: string; cookie: string; userId: string };

/** Signs a user in with email OTP (the same path M2 covers) and returns a bearer token. */
export async function signIn(email: string): Promise<Session> {
  const sent = await send({ method: "POST", path: "/v1/auth/email-otp/send-verification-otp", body: { email, type: "sign-in" } });
  expect(sent.status, sent.text).toBe(200);
  const otp = extractOtp(await waitForEmailText(email));
  const res = await send({ method: "POST", path: "/v1/auth/sign-in/email-otp", body: { email, otp } });
  expect(res.status, res.text).toBe(200);
  return {
    token: res.headers["set-auth-token"]!,
    cookie: res.headers["set-cookie"]!.split(";")[0]!,
    userId: (res.json as { user: { id: string } }).user.id,
  };
}

export const auth = (s: Session) => ({ authorization: `Bearer ${s.token}` });
