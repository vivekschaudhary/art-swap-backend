import type { Context } from "hono";
import { DomainError } from "../errors/domain-error.js";
import type { Auth } from "../auth/auth.js";

export type SessionUser = { id: string; email: string; name: string };

/** Resolves the signed-in user from a session cookie or a bearer token, or throws UNAUTHENTICATED. */
export async function requireUser(auth: Pick<Auth, "api">, c: Context): Promise<SessionUser> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new DomainError("UNAUTHENTICATED", "Authentication required.");
  return { id: session.user.id, email: session.user.email, name: session.user.name };
}
