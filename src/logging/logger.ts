import pino from "pino";

/**
 * Structured JSON logger (docs/v1-design.md §10.4). Bodies are never logged. The redact list is a
 * second line of defence behind the rule that log calls pass only whitelisted fields.
 */
export function createLogger(level: string) {
  return pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: "kindtree-swap-api" },
    messageKey: "msg",
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "cookie",
        "*.cookie",
        "*.token",
        "*.push_token",
        "*.lat",
        "*.lng",
        "*.location",
        "*.email",
        "*.body",
        "*.attachments",
        "*.password",
        "*.secret",
      ],
      censor: "[REDACTED]",
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
