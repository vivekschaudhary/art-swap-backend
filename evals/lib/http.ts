export const BASE_URL = (process.env.EVALS_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

export type CapturedResponse = {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  text: string;
  json: unknown; // undefined when the body isn't JSON
  requestId: string | undefined;
};

export type RequestSpec = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown; // objects are JSON-encoded; strings are sent as-is (for malformed-body tests)
};

export async function send(req: RequestSpec): Promise<CapturedResponse> {
  const headers: Record<string, string> = { accept: "application/json", ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    headers["content-type"] ??= "application/json";
  }

  const res = await fetch(`${BASE_URL}${req.path}`, { method: req.method, headers, body, redirect: "manual" });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  let json: unknown;
  if (/json/.test(contentType)) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  return {
    method: req.method,
    path: req.path,
    status: res.status,
    headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])),
    contentType,
    text,
    json,
    requestId: res.headers.get("x-request-id") ?? undefined,
  };
}
