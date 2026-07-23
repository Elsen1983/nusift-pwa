# Agent 2 Local Parity Debugging

Agent 2 must be debugged local-first. Production is still useful for final validation, but it should not be the first place where no-RSS discovery behavior is understood.

## Why This Exists

Agent 2 depends on several environment-sensitive inputs:

- Database state, including `rssStatus`, productivity counters, prior artifacts, and already-seen articles.
- Network behavior, including Vercel IP reputation and publisher bot protection.
- Runtime capabilities, especially Playwright/browser fallback availability.
- Timezone and date parsing.
- Vercel Function timeout behavior.
- Environment variables such as `NUXT_ENABLE_AGENT2_BROWSER_FALLBACK`.

The local parity runner has two modes:

- bounded batch mode, which mirrors the admin/cron Agent 2 flow and writes to the local DB
- single-target debug mode, which is useful for inspecting one problematic source/category

---

## Docker-Based Browser Parity (Recommended)

### Why Docker?

The production browser fallback path uses `playwright-core` + `@sparticuz/chromium` on a Linux (Debian) runtime. On Windows, the local `npm run dev` environment differs:

- The `launchBrowser()` function detects `VERCEL` or `AWS_LAMBDA_FUNCTION_NAME` to use the production code path (`playwright-core` + `@sparticuz/chromium`).
- Without those env vars, it falls back to full `playwright`, which is not a project dependency and fails with `Cannot find package 'playwright'`.
- Even if installed, Windows Chromium binaries behave differently from the Linux serverless Chromium used in production.

**The correct direction is: local debug runtime should become production-like, not the other way around.** The Docker runner provides a Linux container that mirrors the production Vercel environment exactly.

### Architecture

| Layer | Where it runs | Purpose |
|---|---|---|
| Nuxt dev server / admin UI | Windows host | Normal local development |
| Postgres | Docker container (existing) | Local database |
| Agent 2 Docker runner | Docker container (new) | Production-like Linux runner |

The Docker runner:
- Uses the **same** `playwright-core` + `@sparticuz/chromium` code path as production.
- Sets `VERCEL=1` so the production browser launch path is activated.
- Connects to your local Docker/host Postgres via `host.docker.internal`.
- Runs the existing Agent 2 code paths. Batch mode calls `runArticleDiscoveryBatch`; target mode calls `runAgent2TargetDebug`.

### Prerequisites

- Docker Desktop installed and running.
- A local Postgres instance (Docker or native) accessible from the host.
- A `.env` file with `DATABASE_URL` set.

### Quick Start

**Recommended: run a bounded Agent 2 batch**

This is the local equivalent of the admin/cron Agent 2 flow. It processes as many eligible targets as allowed by `maxTargets` and `timeBudgetMs`, writes candidates/artifacts to the local DB, and can be rerun until `remainingEligible` reaches `0`.

```bash
npm run agent2:docker:batch -- --maxTargets=5 --timeBudgetMs=240000 --minRemainingMs=30000
```

Rerun the same command if the output shows deferred or remaining targets.

**Run the Agent 2 headless/browser fallback queue**

Use this after the bounded batch creates `PENDING_HEADLESS` artifacts. This is the Docker equivalent of the admin panel's `Run browser fallback` button.

```bash
npm run agent2:docker:headless -- --limit=3 --dryRun=false --runBrowser=true
```

For inspection only:

```bash
npm run agent2:docker:headless -- --limit=3 --dryRun=true --runBrowser=true
```

**Run a static-only single target (debug only):**

```bash
npm run agent2:docker -- --sourceId=<source-id> --categoryId=<category-id> --mode=static --persist=false
```

**Run browser fallback for one target (debug only):**

```bash
npm run agent2:docker -- --sourceId=<source-id> --categoryId=<category-id> --mode=browser --persist=false
```

**Run both static and browser for one target (debug only):**

```bash
npm run agent2:docker -- --sourceId=<source-id> --categoryId=<category-id> --mode=both --persist=false
```

**Run one target with a target URL instead of IDs:**

```bash
npm run agent2:docker -- --targetUrl=https://www.bignewsnetwork.com/category/arizona-news --mode=browser --persist=false
```

**Persist one debug target result to the database:**

```bash
npm run agent2:docker -- --sourceId=<source-id> --mode=static --persist=true
```

**Run the runtime sanity check:**

```bash
npm run agent2:docker:check
```

This verifies inside the container:
- `NUXT_ENABLE_AGENT2_BROWSER_FALLBACK` is `true`
- `DATABASE_URL` is present
- `playwright-core` can be imported
- `@sparticuz/chromium` can be imported
- `chromium.executablePath()` resolves
- Prisma can connect to the DB

### Using sourceId / categoryId

You can pass any combination:

```bash
# Source-level target
npm run agent2:docker -- --sourceId=<id> --mode=static --persist=false

# Category-level target
npm run agent2:docker -- --sourceId=<id> --categoryId=<id> --mode=browser --persist=false

# With target URL fallback for ID matching
npm run agent2:docker -- --sourceId=<id> --categoryId=<prod-id> --targetUrl=https://example.com/category/news --mode=both --persist=false
```

If the `categoryId` came from production and doesn't exist in your local DB, pass `--targetUrl` so the runner can attempt URL-based matching.

### Bounded Batch vs Single Target

| Command | Use case | Writes to DB |
|---|---|---|
| `npm run agent2:docker:batch -- --maxTargets=5 --timeBudgetMs=240000` | Normal local Agent 2 parity run. Use this to process the local eligible queue in bounded chunks. | Yes |
| `npm run agent2:docker:headless -- --limit=3 --dryRun=false --runBrowser=true` | Process `PENDING_HEADLESS` browser fallback queue items in production-like Docker runtime. | Yes |
| `npm run agent2:docker -- --targetUrl=... --mode=browser --persist=false` | Inspect one problematic target without changing DB state. | No |
| `npm run agent2:docker -- --targetUrl=... --mode=both --persist=true` | Force one target through debug persistence. Use sparingly. | Yes |

### Database Connection

The PowerShell wrapper automatically converts `localhost` / `127.0.0.1` in `DATABASE_URL` to `host.docker.internal` so the container can reach the host's Postgres.

If your `.env` contains:
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nusift
```

The container will use:
```
DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/nusift
```

**If the DB connection fails:**

1. Ensure Postgres is running and accepting connections on the expected port.
2. Check that Postgres allows connections from Docker's network (not just `localhost`). You may need to set `listen_addresses = '*'` in `postgresql.conf` and add a `host.docker.internal` entry in `pg_hba.conf`.
3. Verify the credentials in `.env` are correct.
4. Run `npm run agent2:docker:check` to see a detailed diagnostic.

### Chromium Runtime Failures

If `chromium.executablePath()` fails inside the container:

1. Run `npm run agent2:docker:check` to see which check failed.
2. The Dockerfile installs all system libraries required by `@sparticuz/chromium`. If a library is missing, check the Docker build output for `apt-get` errors.
3. Ensure the image was built successfully: `docker build -f Dockerfile.agent2-dev -t nusift-agent2-dev .`

### persist=false vs persist=true

| Mode | Behavior |
|---|---|
| `persist=false` | Read-only. Runs discovery and prints JSON output without writing to the database. Safe for inspection and iteration. |
| `persist=true` | Write mode. Creates pipeline artifacts and persists article candidates. Use when you're confident in the results and want to test the full persistence path. |

The `after` snapshot in the output intentionally matches `before` when `persist=false`.

### PowerShell Wrapper Details

The wrapper script (`scripts/dev/run-agent2-docker.ps1`) handles:

1. Building the Docker image if not cached (or if Dockerfile changed).
2. Loading `DATABASE_URL` from `.env` if not set in the environment.
3. Converting `localhost`/`127.0.0.1` to `host.docker.internal`.
4. Setting required env vars (`VERCEL=1`, `NUXT_ENABLE_AGENT2_BROWSER_FALLBACK=true`).
5. Forwarding all CLI arguments to the runner.
6. Supporting `--check-runtime` mode for the sanity check.

You can also call it directly:

```bash
powershell -ExecutionPolicy Bypass -File scripts/dev/run-agent2-docker.ps1 --targetUrl=https://example.com --mode=browser --persist=false
```

---

## Native Local Runner (Static-Only / Non-Docker)

For static-only mode (no browser fallback), you can still run directly on the host without Docker:

```bash
npx tsx scripts/dev/run-agent2-target.ts --sourceId=<source-id> --categoryId=<category-id> --mode=static --persist=false
```

This runs on Windows natively and does not require a browser runtime.

---

## Run One Target Locally (Full Reference)

Static mode, non-mutating:

```bash
npx tsx scripts/dev/run-agent2-target.ts --sourceId=<source-id> --categoryId=<category-id> --mode=static --persist=false
```

Browser mode, non-mutating:

```bash
npx tsx scripts/dev/run-agent2-target.ts --sourceId=<source-id> --categoryId=<category-id> --mode=browser --persist=false
```

Both modes:

```bash
npx tsx scripts/dev/run-agent2-target.ts --sourceId=<source-id> --categoryId=<category-id> --mode=both --persist=false
```

Persisting is opt-in:

```bash
npx tsx scripts/dev/run-agent2-target.ts --sourceId=<source-id> --categoryId=<category-id> --mode=static --persist=true
```

## Example Targets

Times of India Europe category (local DB example):

```bash
npx tsx scripts/dev/run-agent2-target.ts --sourceId=d3b7c5f3-8e72-41cd-9f7d-2c892082366f --categoryId=0beb94bf-c35f-4699-8db8-58b1ad766b97 --mode=static --persist=false
```

> **Note:** Production category IDs may differ from local DB IDs.
> Always discover the correct local ID first:
>
> ```bash
> npx tsx scripts/dev/list-agent2-targets.ts --query=timesofindia
> ```
>
> If you need to use a production `categoryId` that does not exist locally,
> pass `--targetUrl` so the runner can attempt URL-based matching:
>
> ```bash
> npx tsx scripts/dev/run-agent2-target.ts --sourceId=<source-id> --categoryId=<prod-category-id> --targetUrl=https://timesofindia.indiatimes.com/world/europe --mode=static --persist=false
> ```

BigNewsNetwork Arizona category:

```bash
npx tsx scripts/dev/run-agent2-target.ts --sourceId=dfadf552-91ee-48e3-aadb-0775184ca832 --categoryId=4c7ca326-6762-40d3-8bc5-4d212f863379 --mode=both --persist=false
```

## Output

The runner prints compact JSON with:

- Environment snapshot.
- Target state before the run.
- Static discovery summary.
- Browser fallback summary when requested.
- Persistence summary when `persist=true`.
- Target state after the run.

With `persist=false`, the `after` snapshot intentionally matches `before`.

## Export A Minimal Fixture

Use this when a production target needs to be reproduced locally:

```bash
npx tsx scripts/dev/export-agent2-fixture.ts --sourceId=<source-id> --categoryId=<category-id> --out=data/fixtures/agent2/<slug>.json
```

The export is intentionally small:

- One `NewsSource`.
- One `SourceCategory` when applicable.
- Up to 5 relevant Agent 2 artifacts.
- Up to 25 recent articles for already-seen behavior.
- Artifact payloads are summarized, not dumped in full.
- No auth tokens or user secrets are exported.

## Import Fixture

The first pass import command is intentionally read-only:

```bash
npx tsx scripts/dev/import-agent2-fixture.ts --file=data/fixtures/agent2/<slug>.json
```

It validates and summarizes the fixture without writing to the local DB. Add a real import only after reviewing fixture shape and conflict policy.

## Comparing Local And Production

Compare these fields first:

- `environment.browserFallbackEnabled`
- `environment.browserRuntimeAvailable`
- `environment.timezone`
- `before.rssStatus`
- `before.currentFeedProductive`
- `before.consecutiveNonProductiveRuns`
- `static.discoverySources`
- `static.topRejectionReasons`
- `static.listingDiagnostics`
- `browser.browserDiagnostics`

Production-only differences are expected when a site blocks Vercel IP ranges, requires rendered JavaScript, or hits function duration limits.

## Local-First Workflow

1. **Reproduce locally in Docker runner** — Run the target with `--persist=false` to inspect behavior without side effects.
2. **Inspect artifacts/log output** — Review the JSON output, check `static.topRejectionReasons`, `browser.browserDiagnostics`, and `environment` fields.
3. **Only then validate production** — After local behavior is understood and the fix is verified, deploy and compare production output.

## Rules

- Do not weaken the existing two-run rule for `ACTIVE` feeds.
- `NO_RSS_FOUND` targets may be handed to Agent 2 immediately.
- Do not special-case publishers.
- Do not use production as the first debugging environment.
