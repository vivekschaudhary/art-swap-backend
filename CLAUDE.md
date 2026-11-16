# CLAUDE.md: Kindtree Swap API

Read this first. It's the handoff for any agent working in this repo. The source of truth for the design is `docs/v1-design.md`. Where this file and the design doc disagree, the design doc wins, and you should update this file.

## What this is

Headless API for Kindtree Swap. Users list items (art is the launch category, but nothing is art-specific), swipe on other people's items, propose one-for-one swaps, chat about them, meet locally to exchange, and keep a history of completed swaps. Clients: a responsive web app (the `kindtree-web` repo, Next.js, plain website first, with an optional "add to home screen"), and native iOS and Android apps (in design, awaiting store review).

## Status

| # | Milestone | State |
|---|---|---|
| M1 | Foundations: Hono API, errors, logs, OpenAPI, Docker, CI | Done, gating CI |
| M2 | Identity: email codes, Google, passkeys (browser tests pending), profile, location, blocks | Done, gating CI. Passkey and Google browser tests are `it.todo` |
| M3 | Catalog: categories, items, drafts, publish, photo pipeline | Done, gating CI |
| M4 | Discovery: feed, swipes, likes | Done, gating CI |
| M5 | Swaps: request, accept, decline, cancel, completion, history, expiry | Done, gating CI |
| M6 | Messaging: conversations, messages, read state, Ably live token, notifications | Done, gating CI. Push to phones not yet built |
| M7 | Hardening: rate limits, feed batching, 100k load test, Schemathesis, privacy tests, alerts, staging, launch | Not started |

Open items outside the milestones:
- Push notifications to phones (FCM for Android, APNs for iOS). Needs Firebase and Apple credentials.
- Notifications are not yet collapsed per conversation (the design's 5-minute rule).
- Google web client secret is set in production. Confirm sign-in works end to end.
- Native Google client IDs are set (iOS, Android, web) in production.
- Cloudflare warning about a partly exposed origin IP. Vercel and Resend records should be DNS-only. Media (R2) stays proxied.
- The web app is a plain responsive website. "Add to home screen" is optional. The decision is recorded in this file.

## Stack (decided)

- Node.js 24, TypeScript, Hono with `@hono/zod-openapi` (routes defined with `createRoute`, spec at `/v1/openapi.json`, UI at `/docs`).
- Production: API as Vercel Functions (`src/index.ts`, Hono framework preset, region `iad1`). Queue consumers are separate functions in `api/jobs/<topic>.ts`. Cron routes are under `/internal/jobs/cron/<name>`, guarded by `CRON_SECRET`.
- Background jobs: Vercel Queues and Vercel Cron in production (`JOB_BACKEND=vercel`). pg-boss locally (`JOB_BACKEND=pgboss`, worker role).
- Postgres with PostGIS on Supabase (`us-east-1`), connected through the transaction pooler (port 6543). Migrations in `src/db/migrations/`, applied automatically by `.github/workflows/migrate.yml` on push to `main`.
- Auth: Better Auth (email codes, Google, passkeys, bearer tokens). Auth routes at `/v1/auth/*`, not in the OpenAPI spec yet.
- Object storage: Cloudflare R2 through the S3 API. Public variants at `media.kindtree.us`.
- Images: `sharp` inside the media job. WebP variants at 400, 1080 and 2048 px.
- Email: Resend over SMTP (`smtps://resend:<key>@smtp.resend.com:465`). Sender `no-reply@kindtree.us`.
- Live delivery: Ably. The database is the record. Ably carries live events only. Clients get a token from `GET /v1/realtime/token`, scoped to their own conversations.
- Local stack: `docker/docker-compose.yml` (Postgres, s3mock, Mailpit, migrate, api, worker).
- Domains: `kindtree.us` (web), `api.kindtree.us` (API), `media.kindtree.us` (R2 public bucket). Passkey RP ID is `kindtree.us`.

## Non-negotiable rules

1. **Evals first.** Each milestone's evals (`evals/scenarios/<milestone>/`) are written and merged before the implementation. Evals are human-owned.
2. **No PR changes both `src/` and `evals/`.** CI enforces this. Eval fixes go in evals-only PRs.
3. **Activate a milestone in its own evals-only PR**, by adding it to `evals/milestones.json` after the implementation is merged.
4. **No database functions, triggers, rules or `pg_cron`.** Business logic lives in TypeScript. Built-in functions in queries are fine. CI checks migrations.
5. **Vendor SDKs only in `src/adapters/`.** Currently: `@aws-sdk` (object store), `sharp` (images), `pg-boss` (jobs), `@vercel/queue` (jobs), `ably` (realtime), `nodemailer` (mail), `better-auth` (auth, in `src/auth/`).
6. **Errors use the catalog.** Every code is in `src/errors/catalog.ts` and matches design §10.2. `evals/spec/error-codes.ts` must match too. Each code has a fixed HTTP status. For example, `VALIDATION_FAILED` is 400, and `SWAP_OWN_ITEM` is 422.
7. **No `try` in `src/routes/`.** Throw `DomainError`. The static check enforces this. Other rules: no `console.*`, and route modules use `app.openapi(route, handler)`.
8. **Every endpoint is in the OpenAPI spec** (except `/v1/auth/*`, `/internal/*`, `/v1/__test/*`, `/docs`).
9. **Idempotent writes.** Retried requests are safe. Use `Idempotency-Key` on POST where the design says so.

## Working on a change

1. Confirm the milestone is in `docs/v1-design.md`. If the contract is unclear, update the design doc first, in the same PR as the evals.
2. Run the checks locally. Use each one as a separate step, and stop on failure. Don't chain them with `&&` after a subshell that hides the exit code.
   - `npx tsc --noEmit`
   - `npx vitest run` (unit tests in `test/`)
   - `npm run openapi:export` (commit `openapi/openapi.json`)
   - `cd evals && npx spectral lint --fail-severity=warn --ruleset contract/spectral.yaml ../openapi/openapi.json`
   - `cd evals && npx tsx static/check.ts ..`
3. Bring up the local stack:
   ```
   export COMPOSE_FILE=docker/docker-compose.yml
   docker compose up -d --build --wait
   ```
4. Run the scenarios with the milestone active. Edit `evals/milestones.json` locally and don't commit the change. Restore it with `git checkout -- evals/`.
   ```
   cd evals && npx vitest run scenarios
   ```
5. Open the implementation PR without eval changes. After merge, open the activation PR.

## Pitfalls we hit (avoid them)

- **Lockfiles.** A lockfile generated on macOS breaks `npm ci` on Linux CI (missing optional `@emnapi` packages). Regenerate in a temp directory with the Node 24 image, then copy back:
  ```
  t=$(mktemp -d) && cp package.json "$t/" && docker run --rm -v "$t":/w -w /w node:24 sh -c "npm install --package-lock-only --no-audit --no-fund"
  cp "$t/package-lock.json" package-lock.json
  ```
  Do the same for `evals/package-lock.json` if its dependencies change.
- **Root Dockerfile or Compose file.** Vercel reads them and builds a container instead of Functions. Keep them under `docker/`. Compose is `docker/docker-compose.yml`, and the project name is pinned to `art-swap-backend`.
- **Vercel framework.** The project's framework preset must allow Functions, and `vercel.json` sets `"framework": "hono"`. The Hono entry must `import` from `hono` directly.
- **Vercel environment variables.** Use `printf '%s' 'value' | vercel env add NAME --environment production --yes`. Use `vercel env update` to change a value. Environment changes take effect only on a new deployment (`vercel deploy --prod --yes` from `main`).
- **Secrets in this repo's chat history.** Never paste secrets into chat. Use hidden input (`read -s`). The editor's selection can attach text to the chat automatically, so close secret files before chatting.
- **Shell.** `sed -i` with multi-line text has failed in this environment. Use Python for file edits.
- **Protection bypass.** `vercel curl` adds a Deployment Protection bypass to the project. Revoke it with `vercel project protection disable <project> --protection-bypass --protection-bypass-secret <secret>` when done.
- **Cloudflare DNS.** A CNAME can't share a name with other records. Resend's `send` and `rsend` records are CNAMEs and must be DNS-only. Vercel records must be DNS-only. R2 custom domains (`media`) are proxied.
- **Pagination tests.** Page sizes in evals must be smaller than the data the test created. A cursor only appears when older history exists.
- **Operation descriptions.** Spectral requires a description on every operation, and a tag must be declared in `openapi-config.ts`.

## Environments and where things live

- **Production API:** Vercel project `kind-tree/art-swap-backend`. Domain `api.kindtree.us`.
- **Production database:** Supabase, `us-east-1`, transaction pooler.
- **Object store:** R2, buckets `kindtree-prod-private` and `kindtree-prod-public`. The staging buckets exist but aren't used yet.
- **CI secrets (GitHub repository secrets):** `DATABASE_URL` (migrations), `EVALS_ABLY_KEY` (history-only, for the live check), `ABLY_API_KEY` (publish, subscribe and history, for the API in CI).
- **Vercel secrets (production):** all of `docs/v1-design.md` §12, including `DATABASE_URL`, `BETTER_AUTH_*`, `S3_*`, `MEDIA_PUBLIC_BASE_URL`, `SMTP_URL`, `MAIL_FROM`, `GOOGLE_CLIENT_*`, `ABLY_API_KEY`, `CRON_SECRET`, `JOB_BACKEND=vercel`.

## Next steps (in order)

1. **M7 hardening.** Start with rate limits (design §11), then batch the feed's photo queries, then the 100k-item load test. Add Schemathesis on the live spec (non-blocking first). Add privacy tests (no coordinates in any response, already partly covered). Set up alerts (design §10.4).
2. **Web app** in the `kindtree-web` repo. Plain responsive website, reusing the mobile design. Use the API's OpenAPI spec to generate typed clients.
3. **Push notifications** to phones. Needs Firebase and Apple credentials. Web push comes later, for installed web apps only.
4. **Browser tests** for Google and passkeys (`it.todo` in `evals/scenarios/m2-identity/`).
5. **Staging and launch.**

## Decisions that are easy to forget

- Web first, as a plain responsive website. Users aren't asked to install anything. "Add to home screen" is optional. Native apps follow on their store timelines.
- Area labels: a grid label by default. Google Geocoding is used only when `GOOGLE_MAPS_API_KEY` is set. Privacy disclosure and terms review are needed first.
- Swap expiry is 28 days. Accepting a swap invalidates other pending swaps for the same item.
- Completion clones items to the other person as drafts (`source = swap_received`), with photos copied. Originals become `swapped`.
- Chat opens when a swap is requested. Messages are read-only once a swap is declined, withdrawn, expired or cancelled.
- Shipping is not supported in v1. Addresses are not collected in v1.
