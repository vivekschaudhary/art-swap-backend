import { describe, expect, it } from "vitest";
import { COOKIE_DOMAIN, cookieOptions } from "../src/auth/auth.js";

describe("session cookie domain", () => {
  it("shares the session across kindtree.us in production", () => {
    expect(cookieOptions("production")).toEqual({
      advanced: { crossSubDomainCookies: { enabled: true, domain: "kindtree.us" } },
    });
    expect(COOKIE_DOMAIN).toBe("kindtree.us");
  });

  it("leaves local development cookies host-only", () => {
    expect(cookieOptions("development")).toEqual({});
    expect(cookieOptions("test")).toEqual({});
  });
});
