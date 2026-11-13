import type { ErrorCode } from "./catalog.js";
import { ERROR_CATALOG } from "./catalog.js";

export type FieldError = { field: string; message: string };

/** Thrown by services and routes for expected failures. The error handler maps it to problem+json. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly errors: FieldError[] | undefined;

  constructor(code: ErrorCode, detail: string, errors?: FieldError[]) {
    super(detail);
    this.name = "DomainError";
    this.code = code;
    this.status = ERROR_CATALOG[code];
    this.errors = errors;
  }
}
