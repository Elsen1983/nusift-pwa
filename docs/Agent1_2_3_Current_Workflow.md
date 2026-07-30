# NuSift Agent 1-2-3 Current Pipeline Workflow

Last reviewed from code: 2026-07-30

This document describes the current NuSift content pipeline as implemented in the repository. It is written for external review by a larger model or human engineer. It focuses on operational workflow, fallback behavior, retry/cooldown policy, persistence, admin visibility, and known gaps.

## Executive Summary

NuSift currently uses three pipeline agents:

1. **Agent 1 - RSS ingest**
   - Starts from active user/subscribed sources and source categories.
   - Discovers or uses RSS/Atom/JSON feeds.
   - Ingests fresh feed items into the `Article` table.
   - Falls back to HTML link extraction when feeds are unavailable.
   - Applies the shared article URL policy before candidate creation, rejecting obvious non-article URLs such as radio clips, topic/listing pages, checkout/referral pages, account/private pages, search/feed/archive pages, and utility pages.
   - Records `urlPolicyRejected` in structured Agent 1 skip summaries and admin/API diagnostics.
   - Produces audit artifacts and hard-case discovery candidates.
   - Runs in bounded batches for Vercel/serverless safety.

2. **Agent 2 - Article discovery**
   - Runs after Agent 1 batches are complete.
   - Targets sources/categories where RSS is absent, weak, non-productive, or failed.
   - Performs static web discovery from listing pages, sitemap, JSON-LD, and link extraction.
   - Applies the same shared article URL policy in listing extraction, sitemap filtering, and article/canonical metadata evaluation.
   - Persists discovered article candidates.
   - Creates headless/browser fallback queue markers for weak/failed static discovery.
   - Browser fallback can be run separately, locally through Docker for production-like browser runtime parity.

3. **Agent 3 - Article content extraction / enrichment**
   - Runs after Agent 1/2 have inserted article rows.
   - Fetches each article URL and extracts title, excerpt, body text, image, author, date, paywall signals, and provenance.
   - Uses custom DOM scoring and Mozilla Readability as a body extraction candidate.
   - Can optionally use browser fallback for pages blocked or not extractable through static HTTP.
   - Applies source diversity, source cooldown, cross-run retry suppression, and non-retryable failure filtering.
   - Writes article row summaries, body text, and enrichment artifacts.

The pipeline is intentionally split into bounded batches. Agent 1 does not automatically run Agent 2. Agent 2 does not automatically run Agent 3. This is deliberate to avoid Vercel timeouts and to make each stage auditable.

As of the latest implementation pass, the main upstream URL-quality improvement is no longer just a proposal: Agent 1 and Agent 2 now share a generic, score-based URL acceptance policy. The remaining URL-quality work is measurement and calibration: a versioned evaluation framework with tuning/holdout datasets, production-baseline comparison, and candidate shadow decisions.

## Main Runtime Surfaces

### Admin UI

The admin panel exposes separate sections:

- Agent 1 - RSS ingest
- Agent 2 - Discovery and headless queue
- Agent 3 - Article content extraction
- Maintenance
- Agent logs

Each agent has its own run button near its own audit/progress panels.

### Internal cron endpoints

Current cron sequence in `vercel.json`:

- `/api/internal/run-agent1?maxTargets=5&timeBudgetMs=240000&minRemainingMs=30000`
- Multiple Agent 1 slots are configured.
- `/api/internal/run-agent2?maxTargets=5&timeBudgetMs=240000&minRemainingMs=30000`
- Multiple Agent 2 slots are configured after Agent 1.
- `/api/internal/run-hard-case-discovery?limit=10`
- `/api/internal/cleanup-maintenance`

Agent 3 is currently primarily manual/admin-driven and Docker-capable locally. It should not be fully automated by cron until extraction quality and browser fallback behavior are stable enough.

### Local Docker runners

Agent 2 browser-dependent runs use a Docker image that mirrors the production browser runtime more closely than native Windows local dev:

- `npm run agent2:docker:batch -- --maxTargets=5`
- `npm run agent2:docker:headless -- --limit=3 --dryRun=false --runBrowser=true`

Agent 3 also has a Docker runner:

- `npm run agent3:docker -- --maxArticles=10 --browserFallback=true --browserFallbackMaxAttempts=3`
- `npm run agent3:docker:batch -- --maxArticles=5 --includeEnriched=false --forceReprocess=false`

Docker is used for local/prod parity when browser runtime behavior matters.

## Shared Concepts

### Pipeline targets

The active target set is derived from active user/subscribed sources and source categories. A target can be:

- source-level: only `sourceId`
- category-level: `sourceId + categoryId`

Agent 1 considers all active targets eligible. Agent 2 applies stricter eligibility based on RSS/feed state and productivity.

### Bounded batches

Agent 1 and Agent 2 are bounded by:

- `maxTargets`
- `timeBudgetMs`
- `minRemainingMs`

Before starting a new target, they check:

- If `processed >= maxTargets`, stop with `max_targets`.
- If remaining time is below `minRemainingMs`, stop with `time_budget`.
- If no targets exist, stop with `no_targets`.
- Otherwise finish with `completed`.

Deferred targets are persisted as audit artifacts and prioritized in later runs.

### Freshness / retention window

The shared article retention/freshness window is 7 days.

Agent 1:

- Rejects RSS/Atom/JSON items outside the freshness window when a parseable published date exists.
- Rejects missing/invalid/future dates where configured by helper policy.
- HTML fallback uses the same 7-day window.

Agent 2:

- Rejects stale discovered links through discovery freshness policy aligned to article retention.

Maintenance:

- Deletes old unowned articles outside retention if they are not protected by user interactions.

### Article persistence and duplicate avoidance

Agent 1 and Agent 2 persist candidate articles through shared persistence helpers. The dedupe behavior is based on stable fields such as:

- canonical URL
- RSS GUID where available
- normalized content/title hash fields
- existing article/category/tag preservation logic

If a duplicate is found:

- It is skipped as a new insert.
- In some cases existing rows can be preserved or enriched with better category/tag/provenance metadata.

Exact database constraints should be verified in `prisma/schema.prisma` before changing this behavior.

## Agent 1 - RSS Ingest Workflow

### Purpose

Agent 1 is responsible for turning active source/category subscriptions into fresh article rows through feed discovery and feed ingestion.

### Main entry points

- Admin/dev endpoint: `/api/dev/run-news-pipeline`
- Internal cron endpoint: `/api/internal/run-agent1`
- Runtime helper: `runAgent1Batch()`

### Step-by-step flow

1. Resolve active Agent 1 targets.
   - If source/category filters are supplied, hydrate only those targets.
   - Otherwise use all active pipeline targets.
   - Unlike Agent 2, Agent 1 does not filter by RSS status before selecting targets.

2. Prioritize deferred targets.
   - If a previous Agent 1 batch stopped due to `max_targets` or `time_budget`, deferred artifacts are used to prioritize unfinished work.

3. Create a `PipelineRun`.
   - Target count is capped to the smaller of total resolved targets and `maxTargets`.

4. For each target, before starting work:
   - Stop if `processed >= maxTargets`.
   - Stop if remaining time is below `minRemainingMs`.

5. Log `A1_TARGET_STARTED`.

6. Run `ingestSource(sourceId, categoryId?)`.
   - Agent 1 tries to use a known active feed URL where available.
   - If there is no usable feed, it tries feed discovery.
   - Feed discovery can use RSS candidate generation, HTML link tags, anchor-based RSS links, and feed URL patterns.
   - It supports RSS, Atom, and JSON Feed parsing.
   - If feed parsing fails or no feed is available, it can fall back to HTML page link extraction.

7. Parse feed content.
   - RSS items are parsed from `<item>`.
   - Atom items are parsed from `<entry>`.
   - JSON Feed items are parsed from JSON Feed `items`.

8. Normalize each feed item.
   - Clean title, link, GUID, date, description, and categories.
   - Resolve canonical URL.
   - Normalize title/body text.
   - Compute content hash.
   - Build provenance.

9. Apply scope/category filtering.
   - Category targets check URL path scope and/or fallback category token matching.
   - Out-of-scope items are skipped and counted.

10. Apply freshness filtering.
   - Published date must be within the 7-day article retention window.
   - Stale RSS items increment stale skip counters.
   - Missing or invalid dates are tracked in granular stale/missing/invalid counters.

11. Apply HTML fallback if needed.
   - Extract anchor links from the source/category page.
   - Normalize relative links.
   - Keep links on the same root host.
   - Apply article-like URL checks and blocked fallback path checks.
   - Fetch detail pages.
   - Extract metadata.
   - Reject if canonical URL is invalid or blocked.
   - Reject if category-scoped URL is outside category path.
   - Reject if title is too short.
   - Reject if metadata date is stale.
   - Build candidates from detail metadata and stripped HTML preview.

12. Persist Agent 1 pipeline artifacts.
   - `rss_candidates` style diagnostics through `persistPipelineArtifact`.
   - `agent1_target_outcome` artifact with pass/fail/RSS-active/handoff information.
   - Hard-case discovery candidate artifacts where RSS/feed discovery fails in a way that may need deeper discovery later.

13. Persist article candidates.
   - Insert new article rows.
   - Skip duplicates.
   - Count failed inserts.

14. Update feed/productivity status.
   - If feed was productive, mark feed state accordingly.
   - RSS-active with zero new articles is not treated as a hard failure.
   - Non-productive counters are tracked so Agent 2 can later decide whether static discovery is needed.

15. Resolve stale Agent 2/headless markers when Agent 1 finds a scoped RSS feed.
   - Matching headless markers can be marked resolved by Agent 1 RSS.
   - Matching hard-source profiles can be hidden/resolved from active view.
   - This prevents stale Agent 2 errors from remaining active after RSS discovery starts working.

16. Log `A1_TARGET_FINISHED` or `A1_TARGET_FAILED`.
   - Individual target failure does not abort the whole batch.

17. Persist deferred targets if the batch stopped early.
   - Artifacts use `agent1_deferred`.
   - Reason is `max_targets` or `time_budget`.
   - Later Agent 1 runs prioritize these deferred targets.

18. Finalize the `PipelineRun`.

19. Log batch finished/stopped.

### Agent 1 failure behavior

If one target fails:

- Increment failed count.
- Log `A1_TARGET_FAILED`.
- Continue to next target unless batch budget is exhausted.

If there are no targets:

- No `PipelineRun` is created.
- Return `stoppedReason: no_targets`.

If the batch hits Vercel/serverless budget:

- Stop before starting another target.
- Persist remaining targets as deferred.
- UI tells the admin to run Agent 1 again.

### Agent 1 URL policy behavior

Agent 1 now runs the shared article URL policy after canonical URL resolution and before downstream scope/duplicate/freshness checks. If the URL is classified as an obvious non-article URL:

- no ingest candidate is created
- `skipSummary.urlPolicyRejected` increments
- `rejectedItems` records `reason: "url_policy_rejected"`
- the Agent 1 target outcome artifact preserves `skipSummary.urlPolicyRejected`
- the Agent 1 run summary API and admin UI expose the counter as `non-article URL: N`

This currently behaves as an enforced production filter for high-confidence non-article URLs. The policy is generic and score-based rather than publisher-specific.

Important limitation: the current policy is not yet backed by a labeled tuning/holdout evaluation set. The next step is not to add more hard reject rules blindly, but to measure the current production policy against candidate shadow policies.

## Agent 2 - Static Article Discovery Workflow

### Purpose

Agent 2 discovers article URLs for targets where Agent 1 RSS ingest is missing, weak, blocked, stale, or non-productive.

### Main entry points

- Admin/dev endpoint: `/api/dev/run-article-discovery`
- Internal cron endpoint: `/api/internal/run-agent2`
- Runtime helper: `runArticleDiscoveryBatch()`

### Target eligibility

Agent 2 starts from active pipeline targets but filters them using source/category RSS/productivity state.

Typical skip reasons include:

- not found in DB
- requested filter excluded
- RSS active and productive
- RSS active but waiting for two-run/non-productive rule
- RSS pending discovery
- unsupported status

Eligible targets are converted to `ArticleDiscoveryTarget` records with:

- `sourceId`
- `categoryId` if category-level
- target URL
- target type
- RSS/productivity context

### Step-by-step flow

1. Resolve active pipeline targets.

2. Load corresponding `NewsSource` and `SourceCategory` records.

3. For each target:
   - Respect explicit source/category filters.
   - Validate that DB source/category exists.
   - Determine whether the source/category is Agent 2 eligible.
   - Add eligible targets to the batch.
   - Add skipped targets to diagnostics.

4. Prioritize deferred Agent 2 targets from previous bounded runs.

5. Create a `PipelineRun` if there are targets.

6. For each target, before starting work:
   - Stop if `processed >= maxTargets`.
   - Stop if remaining time is below `minRemainingMs`.

7. Run static discovery for the target.
   - Fetch target/listing pages.
   - Extract candidate links from listing HTML.
   - Inspect sitemaps where available.
   - Use JSON-LD/article metadata where available.
   - Normalize links.
   - Score/evaluate article-likeness.
   - Apply freshness and stale-date rejection.
   - Apply category/source scope checks.

8. Build a discovery result.
   - Accepted candidates.
   - Rejected links with reasons.
   - Discovery source counts such as listing, sitemap, JSON-LD.
   - Stale samples/date anomalies.
   - Quality assessment.

9. Persist static discovery artifact.
   - Artifact type: `article_discovery_candidates`.
   - Contains candidate counts, quality, sources, and diagnostics.

10. If static discovery quality is weak/failed/blocked, create headless escalation marker.
   - Artifact type: `article_discovery_headless_required`.
   - Status: `PENDING_HEADLESS`.
   - Payload includes target URL, static quality, escalation reasons, outcome summary, and discovery sources.

11. If static discovery is now productive, resolve stale headless markers.
   - Old pending/browser-failed markers for the same target can be resolved as superseded by static discovery.

12. Persist accepted candidates.
   - Insert new article rows.
   - Skip duplicates.
   - Count failed inserts.

13. If a target throws:
   - Count failure.
   - Log `ARTICLE_DISCOVERY_FAILED`.
   - Continue to next target if budget allows.

14. Persist deferred targets if stopped early.
   - Artifact type: `article_discovery_deferred`.
   - Reason: `max_targets` or `time_budget`.

15. Finalize `PipelineRun` and log finish/stopped status.

### Agent 2 URL policy behavior

Agent 2 uses the same shared URL policy as Agent 1, but at multiple discovery points:

- listing extraction rejects obvious non-article anchors before candidate scoring
- sitemap filtering rejects topic/media/feed/archive/account/checkout/utility URLs while preserving valid article URLs
- article detail metadata evaluation checks both `articleUrl` and canonical URL override
- a canonical URL cannot bypass URL policy rejection if it points to a non-article URL

When `evaluateArticleLinkCandidateFromExtractedMetadata()` rejects a URL through this policy, it preserves existing compatibility by using the existing rejected outcome shape while adding `reason: "url_policy_rejected"`.

Browser fallback does not duplicate the URL policy in its raw link scoring path. Browser-discovered candidates still flow through downstream metadata evaluation before persistence, so the shared policy is applied there.

### Agent 2 quality classification

Agent 2 quality artifacts classify discovery as:

- productive
- weak
- failed
- blocked

Static productive targets generally do not need browser fallback. Weak/failed/blocked targets create headless queue markers.

## Agent 2 Headless / Browser Fallback Queue

### Purpose

The headless queue processes Agent 2 targets where static discovery was insufficient. It can inspect queue state in dry-run mode or run browser-based discovery when explicitly enabled.

### Main entry points

- Admin/dev endpoint: `/api/dev/run-article-discovery-headless-queue`
- Docker local runner:
  - `npm run agent2:docker:headless -- --limit=3 --dryRun=false --runBrowser=true`
- Runtime helper: `processArticleDiscoveryHeadlessQueue()`

### Queue processing modes

1. Dry-run mode
   - Default safe mode.
   - Does not modify DB.
   - Reports which artifacts are valid and would be processed.

2. Non-dry-run without browser
   - Marks relevant items as skipped/disabled/unimplemented depending on current code path.

3. Non-dry-run with browser
   - Requires browser fallback enablement.
   - Uses Playwright/browser runtime.
   - Locally should be run through Docker for parity.

### Step-by-step flow

1. Compute `limit`.
   - Browser runs have stricter caps.
   - Browser queue fetch can over-fetch pending items to scan past cooldown-deferred items.

2. Determine whether browser fallback is enabled.
   - `runBrowser=true` is not enough if the environment flag/runtime is disabled.

3. Fetch `PENDING_HEADLESS` artifacts.
   - Artifact type: `article_discovery_headless_required`.
   - Ordered oldest first.
   - Fetch limit widens only when browser fallback is enabled.

4. If dry-run:
   - Validate payloads.
   - Return would-process counts.
   - Do not update DB.

5. For each queue item in non-dry-run:
   - Validate artifact payload.
   - Invalid payloads are marked `INVALID`.
   - Race-safe `updateMany` is used so concurrent workers cannot double-claim.

6. If browser fallback requested but disabled:
   - Mark artifact `BROWSER_FALLBACK_DISABLED`.
   - Optionally create/update hard-source profile.
   - Continue to next item.

7. Check browser cooldown.
   - Recent artifacts for the same normalized target URL are inspected.
   - If a previous browser run hit rate limit and retry time is still in the future:
     - Keep artifact as `PENDING_HEADLESS`.
     - Update payload with cooldown metadata.
     - Do not consume browser processing cap.
     - Continue to next item.

8. Enforce real browser work cap.
   - Over-fetch scan window does not mean more browser attempts.
   - `browserAttemptedTargets >= limit` stops browser work.

9. Claim artifact.
   - Transition `PENDING_HEADLESS` to `HEADLESS_PROCESSING`.
   - If claim count is zero, another worker already claimed it; count as race-skipped.

10. Run browser discovery.
   - Navigate/render target URL.
   - Extract raw links from rendered page.
   - Apply link filtering and article candidate evaluation.
   - Fetch/evaluate details where applicable.
   - Persist candidates.

11. Classify browser result.
   - If candidates accepted/resolved: status `RESOLVED`.
   - If rendered but no candidates: `BROWSER_NO_CANDIDATES`.
   - If browser runtime unavailable: `BROWSER_RUNTIME_UNAVAILABLE`.
   - If rate-limited: payload stores rate-limit metadata and retry-after time.
   - If no browser candidates after both static and browser fail, create/update hard-source profile.

12. Persist browser result payload.
   - Counts: raw links, evaluated, accepted, rejected, inserted, skipped, shortlisted.
   - Top rejected links.
   - Link filter reasons.
   - Browser diagnostics.
   - Rate-limit/cooldown fields.

13. Return queue result counters.
   - processed
   - browserResolved
   - browserNoCandidates
   - browserCooldownSkipped
   - browserAttemptedTargets
   - inserted/skipped/failed candidate persistence counts

### Hard-source profiles

Hard-source profiles are compact persistent evidence for targets where static and browser discovery both failed.

They can be created when:

- browser fallback is disabled
- browser fallback fails
- browser fallback renders successfully but produces zero accepted candidates

Profiles store:

- static quality
- browser status
- dominant rejection reasons
- link filter reasons
- detail rejection reasons
- suggested next action such as relaxing scope if out-of-category filtering dominates

If Agent 1 later finds an active scoped RSS feed for the same target, matching hard-source profiles can be hidden/resolved from active view.

## Agent 2 Health

Agent 2 health aggregates per-target evidence from static discovery and headless/browser artifacts.

It shows:

- health score
- static quality
- browser status
- last browser attempt/finish
- last good discovery
- cooldown until/retryable time
- rate-limit reason

Targets can be healthy by:

- static productive discovery
- browser-resolved discovery

Targets can remain attention-worthy when:

- browser fallback no candidates
- runtime unavailable
- repeated HTTP 429 cooldown
- hard-source profile exists

## Agent 3 - Article Content Extraction / Enrichment Workflow

### Purpose

Agent 3 takes article rows created by Agent 1/2 and extracts usable article content for the in-app article modal and enrichment fields.

### Main entry points

- Admin/dev endpoint: `/api/dev/run-article-enrichment`
- Local Docker runner:
  - `npm run agent3:docker -- --maxArticles=10 --browserFallback=true --browserFallbackMaxAttempts=3`
- Runtime helper: `runEnrichmentBatch()`

### Selection policy

Agent 3 does not blindly process every row on every run.

It selects:

- `INGESTED` articles.
- `ENRICHMENT_FAILED` articles only if retryable now.
- `ENRICHED` articles needing extractor version reprocess only when `includeEnriched=true`.

It excludes in normal mode:

- current-version non-retryable failures
- current-version recently blocked HTTP 403/429/browser-runtime failures still inside cooldown
- already-current enriched rows with usable body text

Overrides:

- `forceReprocess=true` bypasses normal non-retryable/recent-block filtering.
- explicit `articleIds` bypass freshness and normal filtering.
- extractor version bump makes old failures retryable again.

### Agent 3 progress counts

Admin progress exposes:

- `totalInScope`
- `eligibleNow`
- `retryableNow`
- `recentlyBlocked`
- `nonRetryableCurrentVersionFailures`
- `needingInitialEnrichment`
- `needsCurrentVersionReprocess`
- `currentVersionComplete`
- `remainingAfterLatestRun`

Important interpretation:

- `maxArticles` is an upper limit, not a guarantee.
- If only a few retryable rows survive cooldown/non-retryable/source-diversity filters, a batch may process fewer than `maxArticles`.
- If `retryableNow` is zero, normal Agent 3 work is done for the current extractor version.

### Step-by-step Agent 3 batch flow

1. Parse options.
   - `maxArticles`
   - `includeEnriched`
   - `forceReprocess`
   - `sourceIds`
   - `articleIds`
   - `browserFallback`
   - `browserFallbackMaxAttempts`
   - `browserTimeoutMs`
   - `maxArticlesPerSource`

2. Clamp browser and source-diversity values.
   - Browser max attempts clamp: 0..10.
   - Browser timeout clamp: 5s..45s.
   - Max articles per source clamp: 1..25.

3. Create `PipelineRun`.

4. Log `ARTICLE_CONTENT_ENRICHMENT_STARTED`.

5. Select eligible articles.
   - Apply retention cutoff unless explicit `articleIds`.
   - Fetch more than target limit when filtering can remove non-retryable rows.
   - Apply recent-block state unless `forceReprocess` or explicit article IDs.
   - Apply `isAgent3FailureRetryableNow`.
   - Trim to target limit.

6. Apply source diversity.
   - Round-robin across sources.
   - Cap per source.
   - Explicit `articleIds` bypass diversity.

7. Recover upstream provenance.
   - Uses Agent 1 ingest artifacts where possible.
   - Falls back to article row-derived provenance.

8. For each article:
   - If source is already cooling down during this run, skip and increment source skip count.
   - Persist attempt marker artifact if possible.
   - Attempt marker failure is non-fatal.

9. Configure browser fallback for this article.
   - If globally disabled, no browser config; failure metadata records disabled/not eligible.
   - If source cooldown active, browser fallback skipped reason is `source_cooldown`.
   - If browser attempts exhausted, skipped reason is `max_attempts_exhausted`.
   - If runtime already unavailable globally, skipped reason is `runtime_unavailable_global_stop`.
   - Otherwise browser fallback is allowed with timeout.

10. Run `extractAndBuildArticleOutcome`.

11. Static HTTP extraction path.
   - Calls `extractArticleContentFromUrl`.
   - Validates article URL exists and is valid.
   - Fetches HTML through protected fetch logic.
   - Rejects missing URL, invalid URL, fetch failure, non-HTML response, parse errors, empty HTML, paywall/blocked, canonical mismatch, stale/invalid where applicable.

12. HTML extraction path.
   - Parses HTML with jsdom.
   - Extracts canonical URL.
   - Extracts title.
   - Extracts excerpt/meta description.
   - Extracts image URL.
   - Extracts author.
   - Extracts published date.
   - Extracts body text with custom DOM multi-candidate scoring.

13. Custom body extractor.
   - Collects semantic containers such as `article`, article body selectors, content containers, and `main`.
   - Also considers generic `div`/`section` candidates with enough text.
   - Scores candidates by:
     - paragraph count
     - text length
     - average paragraph length
     - semantic selector bonus
     - link text ratio penalty
     - boilerplate penalty
     - duplicate/heading penalties
     - lead/summary/caption/bullet penalties
   - Expands thin candidates through parent/sibling paragraphs.
   - Stops at boilerplate/boundary elements.
   - Records diagnostics such as selected selector, score, paragraph count, text length, stop reason, top candidates, and boundary markers.

14. Mozilla Readability extraction.
   - Runs as a parallel body extraction candidate inside `extractArticleContentFromHtml`.
   - If custom DOM extraction fails or Readability is materially better, Readability body can be selected.
   - `bodySource` becomes `readability`.
   - Readability body text is now allowed to persist to `Article.bodyText`.

15. Excerpt-vs-body guard.
   - If extracted body equals or strongly overlaps the excerpt/meta description, reject.
   - This prevents saving summaries as article body.

16. Existing body fallback.
   - If no new body exists and existing article body is usable, it can be used as `existing-fallback`.
   - `existing-fallback` is not persisted as newly extracted body text.

17. Paywall/block detection.
   - Runs on raw page text/body/excerpt.
   - If strong paywall signals and body is short, reject as paywall/blocked.

18. Body quality gate.
   - Reject if no body or body is too short.
   - Reject if insufficient sentences.
   - Reject if high link ratio.
   - Reject if below quality threshold.

19. Build extraction success result.
   - Includes title, excerpt, body text, image, author, publishedAt, paywall flag, confidence, quality signals, diagnostics.

20. Browser fallback path.
   - Runs only for eligible failures and when enabled.
   - Uses browser rendering to obtain HTML.
   - Passes rendered HTML through the same `extractArticleContentFromHtml` pipeline.
   - Browser success can produce the same quality-gated output as HTTP extraction.
   - Browser failure records metadata:
     - attempted
     - succeeded
     - runtime unavailable
     - rate limited
     - status code
     - skipped reason
     - browser diagnostics

21. Build `ArticleEnrichmentOutcome`.
   - Classifies terminal kind:
     - `SUCCESS`
     - `SKIPPED`
     - `RETRYABLE_FAILURE`
     - `HEADLESS_REQUIRED`
     - `PAYWALL_BLOCKED`
     - `CANONICAL_MISMATCH`
     - `LOW_CONTENT_QUALITY`
     - `UNSUPPORTED_STRUCTURE`
     - `HTTP_ACCESS_BLOCKED`
   - Stores extractor version.
   - Stores field provenance for title/body/excerpt/image/author/date/paywall.

22. Post-classify HTTP access blocks.
   - If static or browser path saw HTTP 403/429, upgrade kind to `HTTP_ACCESS_BLOCKED`.
   - Browser fallback final status takes precedence over static status.
   - Rejection `httpStatus` and detail text are updated so cooldown logic sees the same final status.

23. Source cooldown tracking.
   - Runs after HTTP access classification.
   - HTTP 429 triggers immediate source cooldown.
   - HTTP 403 requires threshold behavior, usually after repeated failures.
   - Browser runtime unavailable also triggers cooldown behavior.
   - Success resets the source cooldown tracker.
   - Later articles from cooled sources are skipped in the same run.

24. Browser stats tracking.
   - Count attempted, succeeded, failed, runtime unavailable, rate limited.
   - If browser runtime unavailable, stop browser attempts for the rest of the run.
   - If repeated 429s reach threshold, stop browser attempts for the rest of the run.

25. Persist batch outcomes.
   - Update `Article` row summary:
     - enrichment status
     - outcome summary
     - body text when accepted from `dom`, `expanded-dom`, or `readability`
     - paywall flag where available
     - attempt count/timestamps
   - Persist attempt/failure/success artifacts.
   - Persist compact rejection diagnostics.

26. Finalize `PipelineRun`.
   - Summary includes:
     - by-kind counts
     - browser fallback stats
     - source cooldowns
     - options used
     - duration

27. Log `ARTICLE_CONTENT_ENRICHMENT_FINISHED`.

28. If a top-level crash occurs:
   - Mark `PipelineRun` failed if it exists.
   - Emit `ARTICLE_CONTENT_ENRICHMENT_FAILED`.
   - Re-throw the error.

### Agent 3 retry/cooldown policy

`isRecentlyBlocked` excludes current-version failed articles temporarily when:

- HTTP 403 within 24 hours
- HTTP 429 within 1 hour
- browser runtime unavailable within 30 minutes

`isAgent3FailureRetryableNow` returns true for:

- `INGESTED`
- failed rows with missing/legacy outcome
- failed rows from old extractor version
- `HTTP_ACCESS_BLOCKED` after cooldown logic has been handled separately
- transient failures such as retryable/fetch timeout

It returns false for current-version permanent failures such as:

- `LOW_CONTENT_QUALITY`
- `UNSUPPORTED_STRUCTURE`
- `PAYWALL_BLOCKED`
- `CANONICAL_MISMATCH`
- `HEADLESS_REQUIRED` when already attempted and not transient
- unknown/current-version permanent rejection

This prevents one failed article, such as a radio clip or topic page, from consuming a batch slot forever.

### Agent 3 current operational mode

Normal mode:

- `includeEnriched=false`
- `forceReprocess=false`
- `browserFallback=false` unless specifically testing browser extraction

Use `includeEnriched=true` when:

- extractor version changed
- Readability/scoring was improved
- old body text quality should be rechecked

Use `forceReprocess=true` when:

- explicitly testing a failed/non-retryable article
- intentionally overriding cooldown/non-retryable filtering

Use `browserFallback=true` when:

- testing browser extraction
- dealing with JS-rendered pages
- running in Docker or production-like browser runtime

## Maintenance Workflow

The maintenance cleanup is separate from Agent 1/2/3.

It cleans:

- old unowned articles older than the retention window
- old safe diagnostic pipeline artifacts

Production deletion requires explicit environment permission. Dry-run inspection is allowed by default.

Cron endpoint:

- `/api/internal/cleanup-maintenance`

The runner processes pipeline artifacts first, then articles, in time-budgeted repeated batches.

## Current Known Gaps and Recommended Next Work

### 1. URL policy measurement and calibration

The shared Agent 1/2 URL policy now exists and is enforced for high-confidence non-article URLs. The remaining risk is not the absence of a policy, but the absence of objective measurement.

Recommended next work:

- Build a versioned URL policy evaluation framework.
- Create labeled tuning and holdout datasets.
- Run the current production policy and candidate shadow policies on the same URLs.
- Support `ACCEPT`, `REJECT`, and `UNCERTAIN` decisions for candidate policies.
- Keep candidate shadow decisions non-blocking.
- Compare false reject rate, non-article leakage, article recall, precision, uncertain rate, and policy coverage.
- Only promote future candidate rules from `SHADOW` to `ENFORCED` after holdout results are reviewed.

The detailed next prompts for this work live in:

- `docs/nextPrompts/01-url-policy-evaluation-foundation.md`
- `docs/nextPrompts/02-url-policy-evaluation-runner-metrics.md`
- `docs/nextPrompts/03-url-policy-shadow-logging-api-admin.md`
- `docs/nextPrompts/04-url-policy-evaluation-hardening-final-validation.md`

### 2. Candidate/publication lifecycle

Agent 1 and Agent 2 still create `Article` rows before Agent 3 proves that body extraction is usable. The URL policy reduces obvious leakage, but the cleaner long-term design is still one of:

- an `ArticleCandidate` table that is promoted to `Article` only after URL and extraction quality gates pass
- or separate `PipelineStatus` and `PublicationStatus` fields so the normal app feed only reads publishable rows

This should not be implemented until the URL policy evaluation framework provides baseline measurements.

### 3. Agent 3 browser fallback production readiness

Agent 3 browser fallback exists, but should remain carefully bounded:

- browser attempts per batch
- source cooldown
- runtime unavailable stop
- 429 stop
- Docker/local parity testing

Do not put Agent 3 browser fallback on cron until success rates are verified.

### 4. Better action-oriented diagnostics

Admin diagnostics are already useful, but can be improved with clearer categories:

- non-article URL rejected upstream
- access blocked
- cooldown
- permanent extraction failure
- candidate body selected too early
- related/sidebar pollution

### 5. Cron automation for Agent 3

Agent 3 should only be cron-enabled after:

- normal retryable backlog behavior is stable
- URL acceptance is measured and calibrated
- browser fallback behavior is production-safe
- failure categories are clean enough for unattended operation

## End-to-End Recommended Manual Workflow

1. Run Agent 1 batches until Agent 1 progress says remaining is zero.

2. Run Agent 2 batches until Agent 2 progress says remaining is zero.

3. If Agent 2 headless queue has pending browser items:
   - Locally use Docker:
     - `npm run agent2:docker:headless -- --limit=3 --dryRun=false --runBrowser=true`
   - Repeat only when not in cooldown.

4. Run Agent 3 normal batches:
   - `includeEnriched=false`
   - `forceReprocess=false`
   - `browserFallback=false` initially
   - repeat until `Retryable now` is zero.

5. Inspect Agent 3 rejection diagnostics.
   - `HTTP_ACCESS_BLOCKED`: access/cooldown/browser strategy issue.
   - `LOW_CONTENT_QUALITY` with radio/topic/referral URLs: possible upstream URL policy gap or legacy article row created before the current policy.
   - `UNSUPPORTED_STRUCTURE`: possible extractor/Readability/browser fallback issue.

6. Only use `forceReprocess` or `includeEnriched` for targeted testing or after extractor changes.

7. Only use Agent 3 browser fallback in small batches and preferably Docker/local parity when testing.

8. Inspect Agent 1 URL policy counters.
   - In Agent 1 summary, `non-article URL: N` means obvious non-article feed items were rejected before candidate creation.
   - This is expected when feeds contain media clips, topic pages, or utility links.
   - A sudden spike should be reviewed by source/domain.

9. Do not add new URL hard-reject rules directly.
   - New URL policy rules should first go through the versioned evaluation/shadow framework described in `docs/nextPrompts`.

## Summary for External Review

The current NuSift pipeline is a staged, auditable ingestion and enrichment system:

- Agent 1 is feed-first and source/subscription-driven.
- Agent 2 is no-RSS/static discovery plus headless/browser recovery.
- Agent 3 is article content extraction with custom DOM scoring, Mozilla Readability, optional browser fallback, source cooldowns, and retry policy.

The architecture is now operationally coherent. The shared Agent 1/2 URL policy is implemented and prevents many obvious non-article URLs from becoming candidates. The main remaining quality issue is calibration: the policy needs a versioned evaluation framework with labeled tuning/holdout datasets, production-baseline comparison, and candidate shadow decisions before additional rules are promoted to enforced behavior.

The next highest-leverage improvement is therefore not another extractor tweak or broad refactor. It is the measurement foundation documented in `docs/nextPrompts`: evaluation dataset, side-effect-free production policy evaluator, candidate shadow policy, deterministic metrics, and admin/API comparison report.
