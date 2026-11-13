import { z } from "@hono/zod-openapi";

export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string(),
    request_id: z.string(),
    errors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  })
  .openapi("Problem");

/** A problem+json response entry for the OpenAPI document. */
export function problemResponse(description: string) {
  return {
    description,
    content: { "application/problem+json": { schema: ProblemSchema } },
  } as const;
}

/** Documented on every operation (§9): validation, not-found and the 500 INTERNAL body. */
export const COMMON_ERRORS = {
  400: problemResponse("Validation failed"),
  404: problemResponse("Not found"),
  500: problemResponse("Internal error"),
} as const;
