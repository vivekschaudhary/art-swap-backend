/**
 * E1 static rules. Usage: tsx static/check.ts <repoRoot>
 * Exit code 1 when any hard rule is violated. Rules map to docs/v1-design.md §1 and §10.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ERROR_CODES } from "../spec/error-codes.ts";

export type Violation = { rule: string; file: string; line: number; message: string };

const SKIP_DIRS = new Set(["node_modules", ".git", "evals", "dist", ".next", "coverage"]);
const VENDOR_PACKAGES = [/^@supabase\//, /^@vercel\//, /^@aws-sdk\//, /^firebase-admin/];
const ADAPTER_PATH = /(^|[\\/])src[\\/]adapters[\\/]/;

export function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(root, full, out);
    else out.push(full);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Rule: no database functions, procedures, triggers or rules in migrations (§1 principle 5). */
export function checkMigration(file: string, text: string): Violation[] {
  const patterns: [RegExp, string][] = [
    [/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i, "CREATE FUNCTION"],
    [/\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i, "CREATE PROCEDURE"],
    [/\bCREATE\s+(CONSTRAINT\s+)?TRIGGER\b/i, "CREATE TRIGGER"],
    [/\bCREATE\s+(OR\s+REPLACE\s+)?RULE\b/i, "CREATE RULE"],
    [/\bDO\s+\$\$/i, "DO $$ block"],
    [/\bcron\.schedule\s*\(/i, "pg_cron schedule"],
  ];
  const out: Violation[] = [];
  for (const [re, label] of patterns) {
    const m = re.exec(text);
    if (m) {
      out.push({ rule: "E1.no-db-functions", file, line: lineOf(text, m.index), message: `${label} is not allowed in migrations` });
    }
  }
  return out;
}

/** Rule: vendor SDKs are imported only from src/adapters/. */
export function checkVendorImports(file: string, text: string): Violation[] {
  if (ADAPTER_PATH.test(file)) return [];
  const out: Violation[] = [];
  const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\(\s*|import\(\s*)["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1]!;
    if (VENDOR_PACKAGES.some((p) => p.test(spec))) {
      out.push({ rule: "E1.adapters-only", file, line: lineOf(text, m.index ?? 0), message: `vendor SDK "${spec}" imported outside src/adapters/` });
    }
  }
  return out;
}

/** Rule: no console.* in application code. Use the pino logger. */
export function checkConsole(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  for (const m of text.matchAll(/\bconsole\.(log|info|warn|error|debug)\s*\(/g)) {
    out.push({ rule: "E1.no-console", file, line: lineOf(text, m.index ?? 0), message: "use the pino logger, not console" });
  }
  return out;
}

/** Rule: route modules define routes with createRoute and register them through withApi. No try/catch in them. */
export function checkRouteModule(file: string, text: string): Violation[] {
  if (!/(^|[\\/])src[\\/]routes[\\/]/.test(file)) return [];
  const out: Violation[] = [];
  if (/\bapp\.(get|post|put|patch|delete)\s*\(/.test(text)) {
    out.push({ rule: "E1.createRoute", file, line: 1, message: "register routes with createRoute() and withApi(), not raw app.<method>()" });
  }
  if (/\btry\s*\{/.test(text)) {
    out.push({ rule: "E1.no-try-in-routes", file, line: lineOf(text, text.search(/\btry\s*\{/)), message: "route handlers must not catch errors; throw DomainError instead" });
  }
  return out;
}

/** Rule: every DomainError code used in src/ exists in the catalog (§10.2). */
export function checkErrorCodes(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  for (const m of text.matchAll(/new\s+DomainError\(\s*["']([A-Z_]+)["']/g)) {
    const code = m[1]!;
    if (!Object.hasOwn(ERROR_CODES, code)) {
      out.push({ rule: "E1.error-catalog", file, line: lineOf(text, m.index ?? 0), message: `error code ${code} is not in the catalog (docs/v1-design.md §10.2)` });
    }
  }
  return out;
}

const RULES = [checkMigration, checkVendorImports, checkConsole, checkRouteModule, checkErrorCodes];

export function checkFile(root: string, full: string, text: string): Violation[] {
  const file = relative(root, full);
  const out: Violation[] = [];
  if (/\/migrations\/.*\.sql$/.test(file.split(sep).join("/"))) out.push(...checkMigration(file, text));
  if (/\.(ts|tsx|js|mjs)$/.test(file) && file.startsWith(`src${sep}`)) {
    for (const rule of RULES.slice(1)) out.push(...rule(file, text));
  }
  return out;
}

function main() {
  const root = process.argv[2] ?? ".";
  const violations: Violation[] = [];
  for (const full of walk(root)) {
    if (!/\.(sql|ts|tsx|js|mjs)$/.test(full)) continue;
    violations.push(...checkFile(root, full, readFileSync(full, "utf8")));
  }
  for (const v of violations) console.error(`${v.file}:${v.line} [${v.rule}] ${v.message}`);
  console.log(violations.length === 0 ? "E1 static rules: pass" : `E1 static rules: ${violations.length} violation(s)`);
  process.exit(violations.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
