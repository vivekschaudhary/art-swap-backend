/**
 * Reads outgoing email from Mailpit (the local SMTP sink in docker-compose).
 * Mailpit API: GET /api/v1/messages (newest first), GET /api/v1/message/{ID}.
 */
export const MAILPIT_URL = (process.env.EVALS_MAILPIT_URL ?? "http://localhost:8025").replace(/\/$/, "");

type MailpitSummary = { ID: string; To: { Address: string }[]; Created: string };
type MailpitMessage = { Text: string; Subject: string };

/** Polls until a message addressed to `to` arrives, then returns its plain-text body. */
export async function waitForEmailText(to: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`);
    const list = (await res.json()) as { messages: MailpitSummary[] };
    const hit = list.messages.find((m) => m.To.some((t) => t.Address.toLowerCase() === to.toLowerCase()));
    if (hit) {
      const detail = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${hit.ID}`)).json()) as MailpitMessage;
      return detail.Text;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no email to ${to} within ${timeoutMs}ms`);
}

/** Extracts a 6-digit one-time code from an email body. */
export function extractOtp(text: string): string {
  const m = /\b(\d{6})\b/.exec(text);
  if (!m) throw new Error("no 6-digit code found in email");
  return m[1]!;
}
