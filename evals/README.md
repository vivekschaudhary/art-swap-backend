# Kindtree Swap evals

Human-owned checks that decide whether the API matches [docs/v1-design.md](../docs/v1-design.md). Claude may draft evals, but changes here go in evals-only PRs that a human reviews (see §16 of the design doc).

## Layers

| Layer | Command | Needs running API |
|---|---|---|
| E1 static rules | `npm run static` (self-tests: `npm run static:selftest`) | No |
| E2 contract lint | `npm run contract:lint` | No (reads `openapi/openapi.json`) |
| E2 catalog sync | `npx vitest run contract` | No |
| E2 fuzzing | `npm run contract:fuzz` | Yes (`EVALS_BASE_URL`) |
| E2 breaking changes | `npm run contract:diff` | No (reads `origin/main`) |
| E3 and E4 scenarios | `npm run scenarios` | Yes (`EVALS_BASE_URL`, default `http://localhost:3000`) |

`npm run all` runs everything in order.

## Running the scenarios

1. Start the stack: `docker compose up -d` from the repo root (Postgres with PostGIS, MinIO, Mailpit, `api`, `worker`).
2. Start the API in test mode, so the test-only routes exist: `NODE_ENV=test`.
3. Run `npm run scenarios` from this directory.

Logs come from `EVALS_API_LOG_FILE` when set, otherwise from `docker compose logs api`. Set `EVALS_API_LOG_CMD` to override.

## Test-only routes

Some M1 checks need routes that exist only when `NODE_ENV=test`:

| Route | Behaviour |
|---|---|
| `POST /v1/__test/echo` | Body `{ n: integer }`, returns `{ n }`. Used for validation and redaction checks. |
| `GET /v1/__test/boom` | Throws `new Error("boom-internal-secret")`. Used for the 500 and logging checks. |

Both must return `404` in any other environment.

## Layout

```
spec/error-codes.ts        error catalog (must match docs §10.2; checked by contract/catalog-sync.test.ts)
lib/match.ts               partial matcher for response assertions
lib/http.ts                HTTP client for scenarios
lib/logs.ts                reads the API's JSON logs
static/check.ts            E1 rules
contract/                  Spectral ruleset, Schemathesis and oasdiff scripts, catalog sync
scenarios/<milestone>/     one folder per milestone (m1-foundations, m2-identity, …)
invariants/                E4 checks run after each scenario (added with M2)
```

## Rules for changing evals

- Evals-only PRs. Don't touch `src/` in the same PR.
- The error catalog must match the design doc. Change the doc first, then `spec/error-codes.ts`, in the same PR.
- A scenario that fails because the feature isn't built yet is expected. Don't weaken it to get green.
