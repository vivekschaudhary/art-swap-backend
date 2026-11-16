import { describe, expect, it } from "vitest";
import { LOCAL_ORIGINS, WEB_ORIGINS } from "../src/auth/auth.js";

describe("trusted web origins", () => {
  it("includes the production web origin", () => {
    expect(WEB_ORIGINS).toContain("https://kindtree.us");
  });

  it("keeps local development origins out of production", () => {
    expect(WEB_ORIGINS).not.toContain("http://localhost:3000");
    expect(LOCAL_ORIGINS).toContain("http://localhost:3000");
  });
});
