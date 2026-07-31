# NuSift Agent 1–3 Incident Audit Report

**Repository:** NuSift application
**Audit scope:** Agent 1 RSS ingest, Agent 2 article discovery/headless recovery, Agent 3 article extraction/enrichment, database writes, handoffs, retries, deduplication, publication, and production-path test coverage.
**Assessment basis:** Repository implementation, Prisma schema and migrations, cron/API entry points, tests, and the Agent 1/2/3 plans and workflow documents.

## 1. Executive Summary

**Overall risk: High.**

The repository contains substantial defensive engineering: bounded Agent 1 and Agent 2 batches, structured pipeline artifacts, URL-policy filtering, retry/cooldown logic, database uniqueness constraints, compare-and-set claiming for the Agent 2 headless queue, and broad unit-test coverage.

However, the pipeline is **materially vulnerable to cross-stage inconsistency and false-success states**. The main risks are:

- Agent 3 articles are selected without a durable claim or lease, allowing concurrent runs to process the same row and stale results to overwrite newer outcomes.
- Agent 2 can resolve discovery/headless state before Article candidate persistence has succeeded.
- Headless Agent 2 can mark work as resolved when candidates were found in memory but database persistence failed.
- The user feed can expose Article rows before Agent 3 has validated or enriched them.
- Agent 3 can record `feedOrigin: "rss"` when the real origin is unknown.
- Agent 1, Agent 2, and Agent 3 have no general distributed run lock.
- Agent 2 deferred-target prioritization can starve newly eligible targets.
- A working RSS feed can be classified as nonproductive when all returned items are duplicates.
- User source creation starts an unbounded fire-and-forget pipeline.

No confirmed destructive P0 issue was identified in the Agent 1–3 production flow. The P1 issues below should nevertheless be treated as release-blocking for strong idempotency, publication safety, and auditability guarantees.

## 2. Findings

### P1-1 — Concurrent Agent 3 runs can overwrite newer outcomes

- **Classification:** Confirmed implementation risk
- **Location:** `server/utils/news-pipeline/enrichment-runtime.ts`, especially `selectEnrichmentEligibleArticles` and `runEnrichmentBatch`; `server/utils/news-pipeline/enrichment-persist.ts`
- **Issue:** Agent 3 selects eligible Articles without changing their state to a claimed/leased state. Final persistence does not require a worker token or version predicate.
- **Failure scenario:** Two Agent 3 runs select the same `INGESTED` or retryable Article. One run succeeds and writes `ENRICHED`; the other finishes later with a failure or weaker outcome and writes afterward.
- **Impact:** A successful enrichment can be regressed by a stale result. The system also performs duplicate HTTP/browser work and creates duplicate attempt/outcome artifacts.
- **Evidence:** Selection uses `findMany`; there is no Article-level compare-and-set claim. The per-outcome transaction protects the individual update plus artifact creation, but not stale-worker ordering.
- **Recommendation:** Add an Article claim token and lease, claim with a conditional update, and require the token in the final update. Recover expired claims explicitly.

### P1-2 — Agent 2 can resolve markers before candidate persistence succeeds

- **Classification:** Confirmed ordering issue
- **Location:** `server/utils/news-pipeline/article-discovery.ts`, `runArticleDiscoveryBatch` and `resolveStaleHeadlessMarkers`
- **Issue:** Static discovery persists its artifact, creates/escalates queue state, and resolves old headless markers before calling `persistCandidates`.
- **Failure scenario:** Discovery returns productive candidates; old markers are resolved; Article persistence then fails due to a database or constraint error.
- **Impact:** A target can disappear from the retry/recovery queue even though no corresponding Article rows were written. Hard-source evidence can also be hidden prematurely.
- **Evidence:** The implementation order is discovery artifact → escalation marker → stale-marker resolution → candidate persistence.
- **Recommendation:** Persist candidates first and resolve markers only after successful persistence. Use a transaction or an explicit persistence-confirmation state.

### P1-3 — Headless Agent 2 can report `RESOLVED` after failed Article writes

- **Classification:** Confirmed implementation risk
- **Location:** `server/utils/news-pipeline/article-discovery-headless-queue.ts`
- **Issue:** The final queue status is determined from the number of browser candidates, not from successful persistence.
- **Failure scenario:** Browser discovery finds candidates, `persistCandidates` fails, and the artifact still transitions to `RESOLVED` because `candidates.length > 0`.
- **Impact:** The queue reports success while the database may contain no Article rows. Automatic retry is suppressed.
- **Evidence:** Candidate persistence is treated as non-fatal and the final status is based on candidate presence.
- **Recommendation:** Add a persistence-failure status and set `RESOLVED` only when persistence reports no failures and the result is recorded durably.

### P1-4 — The user feed exposes incomplete and failed Article rows

- **Classification:** Confirmed data-publication issue
- **Location:** `server/api/feed.ts`
- **Issue:** The feed filters by source/category subscription but does not require a publishable enrichment or publication state.
- **Failure scenario:** Agent 1 or Agent 2 creates an Article; Agent 3 has not processed it, fails, or rejects it as low-quality/paywalled; the feed still returns the row.
- **Impact:** Users can receive incomplete content, missing body text, or records that Agent 3 classified as unusable.
- **Evidence:** The Article query does not filter by `enrichmentStatus`, `processingStatus`, or an explicit publication status.
- **Recommendation:** Add an explicit publication contract and filter the user feed to publishable records. Keep candidates and failures visible to admin diagnostics.

### P1-5 — Agent 3 can write semantically false provenance

- **Classification:** Confirmed semantic integrity issue
- **Location:** `server/utils/news-pipeline/enrichment-runtime.ts`, `buildArticleProvenance` and `recoverUpstreamProvenanceBatch`
- **Issue:** The fallback provenance sets `feedOrigin: "rss"` when exact artifact matching fails. It also infers category-feed discovery from the existence of `categoryId`.
- **Failure scenario:** An Agent 2 web-discovered Article has no matching Agent 1 artifact. Agent 3 records it as RSS-originated.
- **Impact:** Audit history, source-health analysis, downstream ranking, and incident investigation can use incorrect origin data.
- **Evidence:** The implementation comments describe the fallback as conservative, but `"rss"` is a positive assertion rather than an unknown value.
- **Recommendation:** Represent unknown origin explicitly. Recover provenance from both Agent 1 and Agent 2 artifacts and persist the producing artifact/run reference.

### P1-6 — No general distributed lock prevents overlapping runs

- **Classification:** Confirmed concurrency gap
- **Location:** `server/api/internal/run-agent1.get.ts`, `server/api/internal/run-agent2.get.ts`, `server/utils/news-pipeline/orchestrator.ts`, `article-discovery.ts`, `enrichment-runtime.ts`
- **Issue:** Cron routes authenticate requests but do not enforce agent-level or target-level mutual exclusion.
- **Failure scenario:** A delayed cron invocation overlaps the next cron slot, or an administrator starts a manual run while cron is active.
- **Impact:** Duplicate network work, publisher rate limiting, duplicate artifacts, source-state races, and Agent 3 stale writes.
- **Evidence:** Agent 2 headless queue has a compare-and-set claim, but the main Agent 1/2 target loops and Agent 3 Article selection have no equivalent lock.
- **Recommendation:** Add PostgreSQL advisory locks or durable leases per agent, plus target/Article claims.

### P1-7 — Agent 2 deferred-target prioritization can starve valid targets

- **Classification:** Confirmed logic risk
- **Location:** `server/utils/news-pipeline/article-discovery.ts`, `prioritizeDeferredTargets`
- **Issue:** When deferred priorities exist, the function returns only currently resolved targets that appear in the deferred list. It does not fall back to all current eligible targets when no deferred target remains eligible.
- **Failure scenario:** A previously deferred target becomes Agent 2-ineligible, while a new target becomes eligible. Filtering leaves an empty list and Agent 2 reports `no_targets`.
- **Impact:** Newly eligible targets can be missed indefinitely while stale deferred artifacts remain relevant to selection.
- **Recommendation:** Process eligible deferred targets first, then append current non-deferred targets. Mark stale deferred artifacts superseded.

### P1-8 — Working RSS feeds can be falsely handed off to Agent 2

- **Classification:** Confirmed semantic classification risk
- **Location:** `server/utils/news-pipeline/orchestrator.ts`, `markFeedRunOutcome` calls
- **Issue:** Feed productivity is based primarily on `inserted > 0 || enriched > 0`.
- **Failure scenario:** A valid RSS feed returns recent, in-scope items that are already stored. All candidates are deduplicated, so insertion count is zero.
- **Impact:** The valid feed is eventually classified nonproductive, causing unnecessary Agent 2 discovery and browser work.
- **Recommendation:** Separate fetch success, parse success, valid-item count, fresh-item count, in-scope-item count, inserted count, and duplicate count. Duplicate-only valid runs should remain RSS-owned.

### P1-9 — User source creation uses fire-and-forget unbounded ingestion

- **Classification:** Confirmed operational reliability risk
- **Location:** `server/api/user/sources/add.post.ts`; `server/utils/news-pipeline/orchestrator.ts`, `runNewsPipeline`
- **Issue:** Source creation launches an asynchronous background pipeline without awaiting it. The legacy pipeline is unbounded.
- **Failure scenario:** The API responds successfully, but the serverless runtime ends before the background operation completes or the operation fails after the response.
- **Impact:** Users see successful source creation without reliable ingestion; partial state has no durable job contract.
- **Recommendation:** Create a durable targeted job/run and process it through the bounded Agent 1 path. Return a job identifier and expose progress.

### P1-10 — An Article can retain only one category

- **Classification:** Confirmed schema limitation
- **Location:** `prisma/schema.prisma`, `Article.categoryId`; `server/utils/news-pipeline/ingest.ts`, category attachment logic
- **Issue:** Article/category association is a single nullable foreign key.
- **Failure scenario:** One article belongs to multiple overlapping categories but only one category ID is stored.
- **Impact:** Users subscribed to another valid category can miss the article; category analytics become incomplete.
- **Recommendation:** Add an `ArticleCategory` join model with a uniqueness constraint on `(articleId, categoryId)`.

### P2-1 — Deduplication treats any single identity match as authoritative

- **Classification:** Likely data-loss risk
- **Location:** `server/utils/news-pipeline/ingest.ts`, `persistCandidates`
- **Issue:** Existing rows are matched by RSS GUID OR canonical URL OR content hash. Conflicting identities are not quarantined.
- **Impact:** A reused GUID, bad canonical URL, or hash collision can suppress a valid Article or apply metadata to the wrong row.
- **Recommendation:** Detect identity conflicts and define explicit identity precedence.

### P2-2 — Legacy Agent 1 orchestration can hide target-level failure detail

- **Classification:** Confirmed observability gap
- **Location:** `server/utils/news-pipeline/orchestrator.ts`, `runNewsPipeline`
- **Issue:** Per-target failures are caught with an empty catch body and only increment an aggregate failure count.
- **Impact:** Operators cannot reliably identify which source/category failed or which phase produced the failure.
- **Recommendation:** Emit structured target failure artifacts with phase, error class, retryability, source, and category.

### P2-3 — Agent 3 can label Readability output as DOM output

- **Classification:** Confirmed audit metadata issue
- **Location:** `server/utils/news-pipeline/enrichment-runtime.ts`, `buildBodyTextProvenance`
- **Issue:** Selected body text is recorded as `chosenFrom: "dom"` even when the body source is `readability`.
- **Impact:** Extraction-quality analysis and provenance reports become inaccurate.
- **Recommendation:** Preserve the actual body source in field provenance.

### P2-4 — Attempt-marker failures create audit gaps

- **Classification:** Confirmed observability gap
- **Location:** `server/utils/news-pipeline/enrichment-runtime.ts`, `persistAttemptMarker`
- **Issue:** Attempt-marker persistence is explicitly non-fatal.
- **Impact:** A final outcome can exist without evidence that the attempt was started.
- **Recommendation:** Make attempt identity part of the durable state transition or expose missing-marker metrics.

### P2-5 — URL-policy quality is not yet measured against labeled data

- **Classification:** Documented calibration risk
- **Location:** `server/utils/news-pipeline/article-url-policy.ts`; `docs/url-policy-evaluation-framework.md`
- **Issue:** The policy is enforced, but the repository documents no labeled tuning/holdout baseline.
- **Impact:** False rejection and non-article leakage remain unquantified.
- **Recommendation:** Implement the documented evaluation and shadow-policy framework before expanding enforced rules.

## 3. Agent-by-Agent Analysis

### Agent 1 — RSS/feed ingest

**Intended responsibility:** Resolve active subscribed source/category targets, discover or consume RSS/Atom/JSON feeds, validate freshness/scope/URL quality, persist candidates and evidence, and hand weak/no-feed cases to Agent 2.

**Actual behavior:** The bounded cron path is implemented, but a legacy unbounded path remains active for source creation. Candidate persistence uses in-memory deduplication, database pre-checks, and `createMany({ skipDuplicates: true })`. Feed state, Article rows, and artifacts are written in separate operations.

**Boundary problems:** Agent 1 creates Article rows before Agent 3 proves that the content is usable. Feed productivity conflates new-row creation with feed validity. Exact origin is not guaranteed to reach Agent 3.

**Main downstream risk:** Agent 1 can create a structurally valid but semantically weak Article and can generate incorrect feed-health state that controls Agent 2 eligibility.

### Agent 2 — static discovery and headless recovery

**Intended responsibility:** Discover article URLs for targets where RSS is missing, weak, blocked, or unproductive; preserve evidence; persist candidates; and escalate only when static discovery is insufficient.

**Actual behavior:** Static discovery uses listing pages, sitemaps, JSON-LD, URL scoring, freshness checks, and a shared URL policy. The headless queue has stronger compare-and-set claiming than the main target loop.

**Boundary problems:** Discovery lifecycle state can advance before Article persistence succeeds. `RESOLVED` can mean “found candidates” rather than “stored valid Articles.” Deferred scheduling is not fully robust when old deferred entries become ineligible.

**Main downstream risk:** Agent 2 can report successful recovery while no corresponding Article rows exist, or fail to process newly eligible targets.

### Agent 3 — extraction/enrichment

**Intended responsibility:** Consume Agent 1/2 Article candidates, extract content and metadata, evaluate paywall/access/content quality, preserve provenance, and persist structured outcomes.

**Actual behavior:** Real HTTP extraction, optional browser fallback, quality gates, retry/cooldown logic, source diversity, and per-outcome transactions are implemented. Article selection has no claim/lease and provenance fallback can guess RSS origin.

**Boundary problems:** The feed exposes candidates before Agent 3 validation. Provenance is not reliably authoritative. Concurrent runs can process the same row.

**Main downstream risk:** The Article row, artifact history, and user-visible feed can disagree about whether content is valid, enriched, and publishable.

## 4. Data Integrity Review

### Database writes

Strengths:

- Unique constraints exist for `canonicalUrl`, `rssGuid`, and `contentHash`.
- Agent 3 article update and final enrichment artifact are transactional per outcome.
- Headless queue claims use conditional updates.

Weaknesses:

- Cross-stage writes are not atomic.
- Unique constraints do not resolve semantic identity conflicts.
- Source/category state can be updated independently of Article persistence.
- There is no publication gate at the feed boundary.

### Deduplication

Deduplication prevents some duplicate rows but can suppress valid content when one identity field is wrong or collides. It also does not preserve multiple category memberships.

### Transactions

Agent 3 has the strongest transactional boundary. Agent 1 and Agent 2 discovery artifacts, Article writes, state transitions, marker resolution, and productivity counters are generally separate operations.

### Idempotency

Agent 1/2 inserts are partially idempotent through database constraints. Agent 3 is not operationally idempotent under concurrent execution because selection is not claim-protected. Pipeline runs themselves have no general overlap lock.

### Retries and partial failures

Retries are structured in several areas, but non-fatal errors can leave terminal-looking state. The most serious examples are premature marker resolution and headless `RESOLVED` status after persistence failure.

## 5. Test Coverage Review

The repository test suite passed **76 test files and 2,128 tests** in the audited state. This is a strong regression baseline, but it does not prove the complete production path.

Well-covered areas include:

- URL normalization and URL policy;
- feed parsing and freshness;
- discovery helpers;
- browser/headless helpers through mocks;
- candidate deduplication in isolation;
- extraction heuristics;
- enrichment outcome contracts;
- queue compare-and-set behavior.

The following production scenarios are not sufficiently proven:

- concurrent Agent 3 runs on one Article;
- stale Agent 3 result overwriting a newer success;
- Agent 2 marker resolution followed by candidate persistence failure;
- headless persistence failure after browser discovery;
- deferred Agent 2 starvation;
- duplicate-only RSS productivity classification;
- publication filtering in the user feed;
- Agent 2 provenance recovery into Agent 3;
- overlapping cron/manual Agent 1/2/3 runs;
- serverless termination of fire-and-forget ingestion;
- real PostgreSQL concurrency and unique-constraint behavior;
- multi-category Article visibility.

## 6. Prioritized Conclusion

### Immediate P1 priorities

1. Add Agent 3 Article claims/leases and stale-write protection.
2. Prevent Agent 2 resolution states before persistence confirmation.
3. Prevent headless `RESOLVED` after persistence failure.
4. Gate the user feed by publication state.
5. Replace guessed provenance with explicit unknown and Agent 2 recovery.
6. Add distributed run locks.
7. Fix deferred-target starvation.
8. Correct RSS productivity semantics.
9. Replace fire-and-forget source ingestion.
10. Add many-to-many Article/category support.

### P2 hardening

- Detect conflicting deduplication identities.
- Improve legacy failure logging.
- Preserve actual extraction-method provenance.
- Track missing attempt markers.
- Measure URL-policy precision and recall.
- Add real PostgreSQL and end-to-end pipeline tests.
