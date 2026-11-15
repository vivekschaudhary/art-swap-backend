import { describe, expect, it } from "vitest";
import { authorized } from "../src/http/internal-jobs.js";
import { loadEnv } from "../src/config/env.js";

const SECRET = "0123456789abcdef0123";

describe("cron authorization", () => {
  it("accepts the exact bearer token", () => {
    expect(authorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a missing, wrong, or differently-sized token", () => {
    expect(authorized(undefined, SECRET)).toBe(false);
    expect(authorized("Bearer nope", SECRET)).toBe(false);
    expect(authorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(authorized(SECRET, SECRET)).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    expect(authorized(`Bearer ${SECRET}`, undefined)).toBe(false);
  });
});

describe("job backend configuration", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    S3_ENDPOINT: "http://localhost:9090",
    S3_ACCESS_KEY_ID: "a",
    S3_SECRET_ACCESS_KEY: "b",
    S3_BUCKET_PUBLIC: "p",
    S3_BUCKET_PRIVATE: "q",
    BETTER_AUTH_SECRET: "s".repeat(40),
    BETTER_AUTH_URL: "http://localhost:3000",
    PASSKEY_RP_ID: "localhost",
    PASSKEY_ORIGINS: "http://localhost:3000",
    SMTP_URL: "smtp://localhost:1025",
    MEDIA_PUBLIC_BASE_URL: "http://localhost:9090",
  };

  it("defaults to pg-boss for local runs", () => {
    expect(loadEnv(base).JOB_BACKEND).toBe("pgboss");
  });

  it("requires CRON_SECRET when the Vercel backend is selected", () => {
    expect(() => loadEnv({ ...base, JOB_BACKEND: "vercel" })).toThrow(/CRON_SECRET/);
    expect(loadEnv({ ...base, JOB_BACKEND: "vercel", CRON_SECRET: SECRET }).JOB_BACKEND).toBe("vercel");
  });
});
