import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ERROR_CATALOG, problemType, type ErrorCode } from "./catalog.js";
import type { FieldError } from "./domain-error.js";

export type Problem = {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  request_id: string;
  errors?: FieldError[];
};

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: "Request validation failed",
  UNAUTHENTICATED: "Authentication required",
  FORBIDDEN: "Not allowed",
  ACCOUNT_SUSPENDED: "Account suspended",
  ONBOARDING_REQUIRED: "Onboarding required",
  NOT_FOUND: "Not found",
  VERSION_CONFLICT: "Version conflict",
  IDEMPOTENCY_KEY_REUSED: "Idempotency key reused with a different request",
  ITEM_LOCKED: "Item is locked",
  ITEM_NOT_PUBLISHABLE: "Item is not ready to publish",
  DRAFT_LIMIT_REACHED: "Draft limit reached",
  MEDIA_LIMIT_EXCEEDED: "Media limit exceeded",
  MEDIA_INVALID: "Media is invalid",
  SWAP_ITEM_UNAVAILABLE: "Item is no longer available",
  SWAP_OWN_ITEM: "Invalid item for swap",
  SWAP_DUPLICATE: "Duplicate swap request",
  SWAP_INVALID_TRANSITION: "Invalid swap transition",
  SWAP_EXPIRED: "Swap request has expired",
  FULFILLMENT_NOT_SUPPORTED: "Fulfillment option not supported",
  USER_BLOCKED: "Interaction blocked",
  CONVERSATION_CLOSED: "Conversation is closed",
  RATE_LIMITED: "Too many requests",
  INTERNAL: "Internal error",
  DEPENDENCY_UNAVAILABLE: "Service temporarily unavailable",
};

/** Builds the §10.1 body. Internal errors always use a generic detail. */
export function buildProblem(code: ErrorCode, detail: string, requestId: string, errors?: FieldError[]): Problem {
  const safeDetail = code === "INTERNAL" ? "An unexpected error occurred." : detail;
  return {
    type: problemType(code),
    title: TITLES[code],
    status: ERROR_CATALOG[code],
    code,
    detail: safeDetail,
    request_id: requestId,
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
}

export function problemResponse(c: Context, problem: Problem) {
  return c.body(JSON.stringify(problem), problem.status as ContentfulStatusCode, {
    "content-type": "application/problem+json",
  });
}
