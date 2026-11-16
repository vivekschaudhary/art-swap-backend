import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import type pg from "pg";
import type { Mailer } from "../adapters/mailer.js";

/**
 * Origins allowed to call the auth endpoints from a browser. The web app on kindtree.us reaches the API
 * through a same-origin rewrite, so its requests arrive with the kindtree.us origin.
 */
export const WEB_ORIGINS = ["https://kindtree.us"];
export const LOCAL_ORIGINS = ["http://localhost:3000"];

export type AuthConfig = {
  pool: pg.Pool;
  secret: string;
  baseUrl: string;
  passkeyRpId: string;
  passkeyOrigins: string[];
  mailer: Mailer;
  google?: { clientId: string[]; clientSecret: string };
};

/**
 * Better Auth wired to our Postgres pool. Auth tables live in our database (design §3.1).
 * Plugins: email OTP (sign-in and recovery), bearer tokens for native apps, passkeys.
 * Google is enabled only when its client credentials are configured.
 */
export function createAuth(cfg: AuthConfig) {
  return betterAuth({
    database: cfg.pool,
    secret: cfg.secret,
    baseURL: cfg.baseUrl,
    basePath: "/v1/auth",
    emailAndPassword: { enabled: false },
    trustedOrigins: process.env.NODE_ENV === "production" ? WEB_ORIGINS : [...WEB_ORIGINS, ...LOCAL_ORIGINS],
    socialProviders: cfg.google
      ? { google: { clientId: cfg.google.clientId, clientSecret: cfg.google.clientSecret } }
      : {},
    plugins: [
      emailOTP({
        async sendVerificationOTP({ email, otp, type }) {
          const purpose = type === "sign-in" ? "sign in" : "verify your email";
          await cfg.mailer.send({
            to: email,
            subject: `Your Kindtree code: ${otp}`,
            text: `Use this code to ${purpose}: ${otp}\n\nIt expires in 5 minutes. If you didn't ask for it, ignore this email.`,
          });
        },
      }),
      bearer(),
      passkey({ rpID: cfg.passkeyRpId, rpName: "Kindtree Swap", origin: cfg.passkeyOrigins }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
