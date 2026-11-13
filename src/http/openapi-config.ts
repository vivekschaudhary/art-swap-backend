/** Shared OpenAPI metadata, used by the live /v1/openapi.json and by scripts/export-openapi.ts. */
export const OPENAPI_DOC = {
  openapi: "3.1.0" as const,
  info: {
    title: "Kindtree Swap API",
    version: "1.0.0",
    description: "Headless API for Kindtree Swap (v1). Errors use application/problem+json with a catalog code.",
    contact: { name: "Kindtree", url: "https://kindtree.us" },
  },
  servers: [{ url: "https://api.kindtree.us" }],
  tags: [
    { name: "System", description: "Liveness, readiness and service metadata." },
    { name: "Test", description: "Test-only routes, registered only when NODE_ENV=test." },
  ],
};
