import { randomBytes } from "node:crypto";

const VALID = /^[A-Za-z0-9-]{8,64}$/;

/** Accepts a well-formed client X-Request-Id, otherwise generates a 32-hex id (§4). */
export function resolveRequestId(incoming: string | undefined): string {
  if (incoming && VALID.test(incoming)) return incoming;
  return randomBytes(16).toString("hex");
}
