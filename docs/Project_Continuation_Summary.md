# NuSift Project Continuation Summary

Use this file as handoff context for a new chat or another coding agent.

## Repository

- Workspace: `E:\Study\AI\NuSift\nusift-app`
- Main app: Nuxt/Vue + server API routes
- Database: Prisma/Postgres
- Deployment target: Vercel
- Important constraint: Vercel/serverless runtime limits require bounded batches, explicit time budgets, and careful browser/runtime usage.

## Current Pipeline Architecture

NuSift has three operational content pipeline agents.

### Agent 1 - RSS / Feed Ingest

Purpose:

- Starts from active user/subscribed sources and source categories.
- Discovers or uses RSS/Atom/JSON feeds.
- Ingests fresh feed items into `Article`.
- Falls back to HTML link extraction when feeds are unavailable.
- Runs in bounded batches for Vercel safety.

Current important behavior:

- Freshness/retention is 7 days.
- Agent 1 is bounded by `maxTargets`, `timeBudgetMs`, and `minRemainingMs`.
- If not all targets fit in one run, remaining targets are persisted as deferred and shown in admin progress.
- Agent 1 does not automatically run Agent 2.
- Agent 1 now applies the shared URL policy before candidate creation.
- Obvious non-article URLs increment `skipSummary.urlPolicyRejected` and create `rejectedItems` with `reason: "url_policy_rejected"`.
- Agent 1 summary API/admin displays this as `non-article URL: N`.

### Agent 2 - Static Discovery And Headless Queue

Purpose:

- Runs after Agent 1 is complete.
- Handles sources/categories where RSS is absent, weak, failed, blocked, or non-productive.
- Discovers article URLs from listing pages, sitemaps, JSON-LD, and static link extraction.
- Creates headless/browser fallback queue markers for weak/failed cases.

Current important behavior:

- Agent 2 is bounded and auditable.
- Static productive targets resolve stale headless markers.
- Browser/headless fallback is separate from static discovery.
- Local browser fallback should usually be run through Docker for production-like Linux/Chromium parity.
- Agent 2 now applies the shared URL policy in listing extraction, sitemap filtering, and metadata evaluation for article/canonical URLs.
- Browser fallback raw link scoring does not duplicate the policy; candidates still flow through downstream metadata evaluation before persistence.

Local Docker command for Agent 2 headless queue:

```bash
npm run agent2:docker:headless -- --limit=3 --dryRun=false --runBrowser=true
```

If it finishes immediately with `browserCooldownSkipped`, the queued targets are cooling down and should not be retried until the cooldown expires.

### Agent 3 - Article Content Extraction / Enrichment

Purpose:

- Runs after Agent 1/2 inserted article rows.
- Fetches article URLs and extracts usable content for the in-app article modal and enrichment fields.
- Persists body text, metadata, provenance, and enrichment artifacts.

Current important behavior:

- Uses custom DOM scoring.
- Uses Mozilla Readability as an extraction candidate.
- Readability body text can persist to `Article.bodyText`.
- Uses optional browser fallback for blocked or static-HTTP-failed pages.
- Uses source diversity per batch.
- Uses source cooldowns for repeated HTTP 403, HTTP 429, and browser runtime unavailable cases.
- Uses cross-run retry suppression for recently blocked articles.
- Separates retryable and non-retryable current-version failures.
- Tracks extractor version so old/bad enriched rows can be reprocessed only when needed.
- Normal mode should use:
  - `includeEnriched=false`
  - `forceReprocess=false`
  - `browserFallback=false`
- Use `includeEnriched` or `forceReprocess` only after extractor changes or targeted tests.
- Use browser fallback in small bounded batches only.
- Agent 3 is not yet recommended for full unattended cron automation.

## Admin Workflow

Recommended manual flow:

1. Run Agent 1 batches until Agent 1 progress says remaining is zero.
2. Run Agent 2 batches until Agent 2 progress says remaining is zero.
3. If Agent 2 headless queue has pending browser items, run the Docker headless command locally.
4. Run Agent 3 normal batches until `Retryable now` is zero.
5. Inspect Agent 3 rejection diagnostics.
6. Use force reprocess or browser fallback only for targeted testing.
7. Inspect Agent 1 URL policy counters for `non-article URL: N`.

## Maintenance

There is safe maintenance cleanup for:

- old unowned articles older than retention window
- old safe diagnostic pipeline artifacts

Production deletion requires explicit environment permission. Dry-run inspection is allowed by default.

Cron endpoint:

- `/api/internal/cleanup-maintenance`

## Important Recent Changes

Recently implemented and pushed:

- Agent 3 content extraction using custom DOM scoring.
- Mozilla Readability integration.
- Agent 3 browser fallback and Docker runner.
- Agent 3 source cooldowns, HTTP access blocked classification, retry suppression, and non-retryable failure filtering.
- Agent 3 admin progress and rejection diagnostics.
- Shared Agent 1/2 URL policy.
- Structured `urlPolicyRejected` persistence and admin/API visibility.
- Real Agent 1 ingest-path tests for URL policy rejection.
- Agent 2 metadata evaluator tests for article/canonical URL policy rejection.
- Detailed workflow documentation.
- Next prompts for a versioned URL-policy evaluation framework.

Latest pushed commit at the time of this handoff:

- `79b3a10 Advance NuSift agent pipeline accuracy and enrichment`

Validation that was run before that push:

- `npx nuxt typecheck`
- targeted Vitest: 8 test files, 428 tests passed

## Important Files

Workflow and planning:

- `docs/Agent1_2_3_Current_Workflow.md`
- `docs/nextPrompts/01-url-policy-evaluation-foundation.md`
- `docs/nextPrompts/02-url-policy-evaluation-runner-metrics.md`
- `docs/nextPrompts/03-url-policy-shadow-logging-api-admin.md`
- `docs/nextPrompts/04-url-policy-evaluation-hardening-final-validation.md`

Agent 1:

- `server/utils/news-pipeline/ingest.ts`
- `server/utils/news-pipeline/orchestrator.ts`
- `server/api/dev/agent1-run-summary.get.ts`
- `server/utils/news-pipeline/ingest.integration.test.ts`

Agent 2:

- `server/utils/news-pipeline/article-discovery.ts`
- `server/utils/news-pipeline/article-discovery-helpers.ts`
- `server/utils/news-pipeline/article-discovery-browser.ts`
- `scripts/dev/run-agent2-docker.ps1`

Agent 3:

- `server/utils/news-pipeline/article-content-extractor.ts`
- `server/utils/news-pipeline/article-content-browser-extractor.ts`
- `server/utils/news-pipeline/enrichment.ts`
- `server/utils/news-pipeline/enrichment-runtime.ts`
- `server/utils/news-pipeline/enrichment-persist.ts`
- `server/api/dev/run-article-enrichment.post.ts`
- `server/api/dev/agent3-progress.get.ts`
- `server/api/dev/agent3-rejection-diagnostics.get.ts`
- `scripts/dev/run-agent3-docker.ps1`

Shared policy/diagnostics:

- `server/utils/news-pipeline/article-url-policy.ts`
- `server/utils/news-pipeline/article-url-policy.test.ts`
- `server/utils/news-pipeline/rejection-diagnostics-normalizer.ts`

Admin UI:

- `app/pages/audit/admin.vue`
- `app/components/ArticleReaderModal.vue`
- `app/pages/dashboard/dashboard-main.vue`

## Current Main Open Work

The next recommended work is not a broad refactor. It is:

Versioned URL Policy Evaluation Framework with Shadow Decisions and Baseline Comparison

This should be implemented through the numbered prompts in `docs/nextPrompts`.

Why:

- The shared Agent 1/2 URL policy now exists.
- Additional hard reject rules should not be added blindly.
- The system needs a labeled tuning/holdout dataset, production-baseline comparison, candidate shadow policy, deterministic metrics, and admin/API reporting.

Strictly out of scope for the next ticket:

- production gating changes
- PUBLISHABLE status
- ArticleCandidate refactor
- Source Registry
- event clustering
- ranking
- fact-checking
- review queue
- new infrastructure

## Engineering Notes

- Inspect real code before trusting summaries.
- Avoid `git add .`; stage relevant files explicitly.
- Avoid cache/dump/data files.
- Use `npx nuxt typecheck`.
- On Windows, if direct npm/npx has shell friction, use `C:\Windows\System32\cmd.exe /c npx ...`.
- Keep Vercel/serverless limits in mind.
- Keep browser fallback bounded and cooldown-aware.
- Do not run long HTTP/browser work inside long DB transactions.
