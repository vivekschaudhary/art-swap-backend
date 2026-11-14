import { DomainError } from "../errors/domain-error.js";

/** Opaque keyset cursor over (created_at, id), newest first. Invalid cursors are a validation error. */
export function encodeCursor(createdAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { t: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t: string; id: string };
    return parsed.t && parsed.id ? parsed : null;
  } catch {
    throw new DomainError("VALIDATION_FAILED", "The cursor is not valid.");
  }
}
