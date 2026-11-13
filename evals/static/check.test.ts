// Self-tests for the E1 rules: each rule must catch a planted violation and pass clean code.
import { describe, expect, it } from "vitest";
import { checkConsole, checkErrorCodes, checkMigration, checkRouteModule, checkVendorImports } from "./check.ts";

describe("E1.no-db-functions", () => {
  it("flags functions, triggers, procedures, rules, DO blocks and pg_cron", () => {
    const bad = [
      "CREATE OR REPLACE FUNCTION bump() RETURNS trigger AS $$ ... $$ LANGUAGE plpgsql;",
      "CREATE TRIGGER t BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION bump();",
      "CREATE PROCEDURE p() LANGUAGE sql AS $$ $$;",
      "CREATE RULE r AS ON INSERT TO items DO ALSO NOTHING;",
      "DO $$ BEGIN PERFORM 1; END $$;",
      "SELECT cron.schedule('expire', '0 * * * *', 'select 1');",
    ];
    for (const sql of bad) expect(checkMigration("m.sql", sql), sql).not.toHaveLength(0);
  });

  it("passes ordinary DDL and built-in calls", () => {
    const ok = "CREATE TABLE items (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());\nCREATE INDEX ON items USING gist (location);";
    expect(checkMigration("m.sql", ok)).toEqual([]);
  });
});

describe("E1.adapters-only", () => {
  it("flags vendor SDK imports outside src/adapters", () => {
    const text = `import { createClient } from "@supabase/supabase-js";\nconst s3 = require("@aws-sdk/client-s3");`;
    expect(checkVendorImports("src/services/items.ts", text)).toHaveLength(2);
  });

  it("allows vendor SDKs inside src/adapters", () => {
    const text = `import { S3Client } from "@aws-sdk/client-s3";`;
    expect(checkVendorImports("src/adapters/r2.ts", text)).toEqual([]);
  });
});

describe("E1.no-console", () => {
  it("flags console calls and passes pino", () => {
    expect(checkConsole("src/x.ts", 'console.log("hi")')).toHaveLength(1);
    expect(checkConsole("src/x.ts", 'logger.info({ request_id }, "hi")')).toEqual([]);
  });
});

describe("E1.createRoute and E1.no-try-in-routes", () => {
  it("flags raw app.get and try blocks in route modules", () => {
    const text = `app.get("/v1/x", async (c) => { try { return c.json({}) } catch { } });`;
    const rules = checkRouteModule("src/routes/x.ts", text).map((v) => v.rule);
    expect(rules).toEqual(expect.arrayContaining(["E1.createRoute", "E1.no-try-in-routes"]));
  });

  it("passes a createRoute definition and ignores files outside routes", () => {
    const ok = `export const getX = createRoute({ method: "get", path: "/v1/x" });`;
    expect(checkRouteModule("src/routes/x.ts", ok)).toEqual([]);
    expect(checkRouteModule("src/services/x.ts", `try {} catch {}`)).toEqual([]);
  });
});

describe("E1.error-catalog", () => {
  it("flags unknown codes and passes catalog codes", () => {
    expect(checkErrorCodes("src/x.ts", `throw new DomainError("MADE_UP_CODE", "x")`)).toHaveLength(1);
    expect(checkErrorCodes("src/x.ts", `throw new DomainError("SWAP_ITEM_UNAVAILABLE", "x")`)).toEqual([]);
  });
});
