# NuSift

NuSift is a Nuxt 4 + Vue 3 application for AI-assisted news discovery, source management, and article filtering. It uses Prisma + PostgreSQL for persistence and a shared server-side content pipeline to discover feeds, ingest articles, and keep discovery evidence for later review.

## What the app does

- discovers and verifies RSS / Atom feeds for root sources and scoped category sources
- ingests articles into a shared article store
- normalizes titles, URLs, bodies, and provenance data
- keeps hard-case discovery artifacts for unresolved feeds
- supports browser-assisted fallback discovery for difficult sites
- exposes a dashboard for article browsing and filtering
- exposes a source-manager UI for active, suspended, and restricted sources
- supports manual feed review / override flows
- includes admin/dev endpoints for pipeline runs, audits, and maintenance

## Architecture

### 1. Discovery layer

The pipeline starts by resolving feed candidates for:

- `NewsSource`
- `SourceCategory`

Discovery uses:

- direct RSS / Atom detection
- HTML link / header discovery
- sitemap discovery
- taxonomy-aware scoped heuristics
- feed-directory traversal fallback
- browser-assisted hard-case fallback

### 2. Ingest layer

Once a feed is verified, NuSift ingests articles through a shared pipeline that:

- normalizes raw article data
- computes canonical URLs and content hashes
- filters duplicates and stale items
- persists `Article` records
- stores candidate provenance and skip / rejection reasons

### 3. Hard-case layer

Unresolved discovery cases are written to pipeline artifacts and later processed by a hard-case queue. When a target is resolved, the system can trigger a targeted rerun for only the affected source/category instead of rerunning everything.

### 4. UI layer

The frontend provides:

- dashboard article browsing with date / category / source filters
- source-manager tooling for feed recovery and manual overrides
- profile page features for account and social preferences
- admin/dev controls for pipeline maintenance

## Stack

- **Framework:** Nuxt 4
- **UI:** Vue 3, Tailwind CSS, Pinia
- **Backend:** Nitro / H3 server routes
- **Database:** PostgreSQL
- **ORM:** Prisma
- **Auth:** JWT sessions in httpOnly cookies
- **Notifications:** Web Push / VAPID, email via Resend
- **Testing:** Vitest, TypeScript

## Local Setup

### Install

```bash
npm install
```

### Environment

Create a `.env` file with at least:

- `DATABASE_URL`
- `JWT_SECRET`
- `NUXT_PUBLIC_APP_URL`

Optional integrations:

- `NUXT_PUBLIC_GOOGLE_CLIENT_ID`
- `NUXT_PUBLIC_APPLE_CLIENT_ID`
- `NUXT_VAPID_PRIVATE_KEY`
- `NUXT_PUBLIC_VAPID_PUBLIC_KEY`
- `NUXT_VAPID_SUBJECT`
- `RESEND_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Some dev/admin endpoints also depend on runtime flags such as:

- `NUXT_ALLOW_MANUAL_NOTIFICATION_RUN`
- `NUXT_ADMIN_EMAILS`
- `NUXT_CRON_SECRET`
- `NUXT_PIPELINE_VERBOSE_LOGS`

### Database

Generate the Prisma client:

```bash
npm run postinstall
```

Or explicitly:

```bash
npx prisma generate
```

If your local schema changes, sync it with the database before testing pipeline behavior:

```bash
npx prisma db push
```

### Development server

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

### Production build

```bash
npm run build
```

### Preview production build

```bash
npm run preview
```

### Tests

```bash
npm run test
```

### Prisma Studio

```bash
npm run prisma:studio
```

## Useful endpoints

The app includes several internal and dev-only endpoints for pipeline operations, feed auditing, and source management. These are guarded by auth and, in production, by additional flags or secrets where appropriate.

Common examples:

- `POST /api/dev/run-news-pipeline`
- `POST /api/dev/run-hard-case-discovery`
- `POST /api/dev/import-rss`
- `POST /api/user/sources/feed`
- `GET /api/internal/run-hard-case-discovery`

## Project layout

- `app/` - Nuxt pages, components, layouts, stores, client logic
- `server/` - API routes, middleware, and pipeline utilities
- `prisma/` - schema and migrations
- `docs/` - implementation plans, audits, and agent documentation
- `scripts/` - maintenance and content tooling
- `data/` - generated audit/report artifacts

## Notes for contributors

- The pipeline is shared. It is not a per-user crawler.
- Discovery is intentionally bounded and fallback-driven.
- Active user-linked sources are the primary execution scope.
- Discovery evidence and artifacts are part of the contract, not debug leftovers.
- Feed changes should preserve provenance and verification state.

## License

No license has been declared yet.
