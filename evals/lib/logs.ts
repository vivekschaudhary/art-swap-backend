import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Reads the API's structured JSON logs.
 *
 * - EVALS_API_LOG_FILE: path to a file of JSON lines, if set.
 * - Otherwise runs EVALS_API_LOG_CMD (default: `docker compose logs --no-log-prefix --no-color api`
 *   from the repo root).
 *
 * Non-JSON lines are ignored.
 */
export function readApiLogs(): Record<string, unknown>[] {
  const raw = process.env.EVALS_API_LOG_FILE
    ? readFileSync(process.env.EVALS_API_LOG_FILE, "utf8")
    : execSync(process.env.EVALS_API_LOG_CMD ?? "docker compose logs --no-log-prefix --no-color api", {
        cwd: new URL("../..", import.meta.url).pathname,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });

  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // ignore partial or non-JSON lines
    }
  }
  return out;
}

/** Log lines that belong to one request. Accepts `request_id` at the top level (the §10.4 shape). */
export function linesForRequest(lines: Record<string, unknown>[], requestId: string) {
  return lines.filter((l) => l.request_id === requestId);
}

/** Accepts pino numeric levels and string levels. */
export function levelName(level: unknown): string | undefined {
  if (typeof level === "string") return level.toLowerCase();
  if (typeof level === "number") {
    return ({ 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" } as Record<number, string>)[level];
  }
  return undefined;
}

export const STACK_RE = /\n\s+at\s+\S/;

/** Logs are flushed asynchronously; poll briefly until `predicate` holds or time runs out. */
export async function waitForLogs(
  requestId: string,
  predicate: (lines: Record<string, unknown>[]) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  let lines: Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    lines = linesForRequest(readApiLogs(), requestId);
    if (predicate(lines)) return lines;
    await new Promise((r) => setTimeout(r, 250));
  }
  return lines;
}
