import { describe, expect, it } from "vitest";
import { googleProviderConfig } from "../src/auth/google-config.js";

const WEB = "web-id.apps.googleusercontent.com";
const IOS = "ios-id.apps.googleusercontent.com";

describe("googleProviderConfig", () => {
  it("accepts web and iOS IDs as audiences when the secret is set", () => {
    expect(googleProviderConfig({ GOOGLE_CLIENT_ID_WEB: WEB, GOOGLE_CLIENT_ID_IOS: IOS, GOOGLE_CLIENT_SECRET: "s" })).toEqual({
      clientId: [WEB, IOS],
      clientSecret: "s",
    });
  });

  it("stays off without the web client secret", () => {
    expect(googleProviderConfig({ GOOGLE_CLIENT_ID_WEB: WEB, GOOGLE_CLIENT_ID_IOS: IOS })).toBeUndefined();
  });

  it("stays off without any client ID", () => {
    expect(googleProviderConfig({ GOOGLE_CLIENT_SECRET: "s" })).toBeUndefined();
  });

  it("ignores empty values", () => {
    expect(googleProviderConfig({ GOOGLE_CLIENT_ID_WEB: "", GOOGLE_CLIENT_ID_IOS: IOS, GOOGLE_CLIENT_SECRET: "s" })?.clientId).toEqual([IOS]);
  });
});
