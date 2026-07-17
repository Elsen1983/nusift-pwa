# Agent 3 - Article enrichment and content extraction

## Dev Plan

## 1. Role in the pipeline

The NuSift content pipeline can now be split into four layers:

1. **Agent 1**: source/category RSS discovery, feed ingest, candidate normalization, artifact evidence persistence
2. **Agent 2**: web discovery and article acquisition for sources where RSS is missing, weak, partial, or not trustworthy
2. **Agent 3**: article-level enrichment on already stored candidate/article records
3. **Agent 4**: per-user relevance scoring and feed ordering
4. **Agent 5**: lifecycle, retention, archive/prune, and later social / advanced recommendation

Agent 3 is **not** a feed discovery agent. It does not work on source URLs. It builds on the data already collected by Agent 1:

- discovered feeds
- ingested articles
- stored artifact payloads
- raw / normalized / provenance evidence

## 2. Input and output

### 2.1 Input

Agent 3 primarily consumes:

- `Article` records coming from Agent 1
- related `PipelineArtifact` records
- artifact payload data containing:
  - raw title/body values
  - normalized title/body values
  - discovery / feed provenance
  - candidate rejection / skip information
  - feed format and candidate metadata

Important architectural decision:

- Agent 3 should not rely only on `Article.title` / `Article.bodyText`
- Agent 3 should also use the evidence stored by Agent 1
- this keeps the system auditable: what came from the feed and what came from the article page remains visible

### 2.2 Output

Agent 3 output should include:

- enriched `Article` record
- enrichment result artifact
- structured extraction outcome
- optional hard-case queue entry for later headless processing
- article-level paywall status and evidence

## 3. Responsibility boundary

### Agent 3 does

- opens the article URL
- extracts HTML / meta / canonical data
- improves or expands title, excerpt, body, image, author, publish date
- detects and refines article-level paywall status
- estimates content quality
- stores extraction evidence
- stores structured failure / skip outcomes

### Agent 3 does not do

- RSS discovery
- root / category feed discovery
- source / category status handling
- user personalization
- ranking
- archive / prune
- heavy headless browser execution inline in the pipeline

Note:

- Agent 1's current `isPaywall` flag is at best a feed-level or fallback HTML heuristic.
- On the same domain there may be both free and paywalled articles.
- Because of that, the final article-level paywall state should be re-evaluated per article by Agent 3.

## 4. What it must align with in the current system

The new plan must fit the already existing Agent 1 behavior:

- `PipelineRun` and `PipelineArtifact` already exist
- `NewsSource.discoveryEvidence` and `SourceCategory.discoveryEvidence` already exist
- the pipeline already runs only on active, user-linked source/category targets
- ingest already stores normalized data and provenance-like information

So Agent 3 should not be designed as if the system were still only a simple RSS -> Article insert flow.

### 4.1 Explicit upstream Agent 1 behavior

Current Agent 1 is more than fetch-based feed discovery.

Verified upstream elements that Agent 3 must respect:

- after normal discovery, a hard-case artifact queue can also be created
- the hard-case consumer runs fetch + browser fallback logic
- browser fallback resolver metadata is stored:
  - `resolverPath`
  - `browserAttempted`
  - `browserMethod`
  - `browserCandidateCount`
  - `browserCandidates`
  - `browserError`
- `NewsSource.discoveryEvidence` and `SourceCategory.discoveryEvidence` can include this context
- after successful hard-case resolution, Agent 1 triggers a targeted pipeline rerun
- that rerun is not global, but targeted:
  - for a source target, only that source
  - for a category target, only the parent source plus that category

This matters for Agent 3 because the article universe may not be complete after the first ingest pass. Later hard-case queue resolution and targeted reruns can bring in additional relevant articles for the same source/category universe.

## 5. Data model expectations

Agent 3 will likely need additional fields on the `Article` model:

- `enrichmentStatus`
- `enrichmentStartedAt`
- `enrichmentFinishedAt`
- `enrichmentAttemptCount`
- `enrichmentMethod`
- `enrichmentConfidence`
- `enrichedTitle`
- `enrichedExcerpt`
- `enrichedBodyText`
- `enrichedBodyHtml`
- `enrichedImageUrl`
- `enrichedAuthor`
- `enrichedPublishedAt`
- `enrichedIsPaywall`
- `enrichmentEvidence` or a separate artifact payload

Recommended states:

- `INGESTED`
- `ENRICHING`
- `ENRICHED`
- `ENRICHMENT_FAILED`
- `ENRICHMENT_SKIPPED`
- `ENRICHMENT_QUEUED_HEADLESS`

Note:

- enrichment evidence can live in a separate `Article` JSON field or only in the artifact payload.
- to keep DB pressure lower, it is better to store detailed evidence primarily in artifact payloads, and keep only short summary fields on the `Article` record.

## 6. Recommended runtime model

### 6.1 Not inline-first

The first version of Agent 3 should **not** be forced to run inline immediately after Agent 1.

Better flow:

1. Agent 1 runs
2. it stores articles and artifacts
3. Agent 3 selects fresh articles that are suitable for enrichment
4. it processes them in a separate batch

This is better because:

- it does not increase ingest pipeline runtime too much
- it does not mix feed discovery errors with content extraction errors
- it scales cheaper and more cleanly
- it is easier to move to a queue later

### 6.2 Batch selection rule

Agent 3 should only run on articles that:

- were successfully stored by Agent 1
- are at most 7 days old
- belong to an active user-linked source/category universe
- are not yet successfully enriched
- or failed earlier for a retryable reason

### 6.3 Rerun-compatible selection

Agent 3 selection logic must be compatible with Agent 1's hard-case resolution reruns.

Therefore:

- Agent 3 should not think only in terms of the "last pipeline run"
- it should incrementally pick up new articles
- it must not assume that a source/category with few or zero articles earlier will stay that way forever
- the refresh basis can be:
  - `createdAt`
  - `updatedAt`
  - enrichment status
  - related pipeline artifact or pipeline run time

Agent 3 works correctly only if articles added during hard-case reruns are automatically eligible for enrichment.

## 7. Extraction strategy

### 7.1 Multi-step HTTP extraction

Start with HTTP-only enrichment:

1. canonical URL and redirect check
2. `<title>`, `og:title`, `twitter:title`, meta description
3. search for `article`, `main`, and content block selectors
4. article-level paywall signal detection
5. body cleaning
6. quality scoring
7. only overwrite fields when the new value is genuinely better

### 7.1.1 Article-level paywall detection

Agent 3 should determine on a per-article basis whether the given URL is actually paywalled.

Possible signals:

- structured data and meta fields:
  - `isAccessibleForFree`
  - `hasPart`
  - `cssSelector`
  - publisher-specific premium / subscriber-only metadata
- DOM signals:
  - subscribe / premium / member-only overlays
  - blurred or cut-off article body
  - login wall / subscription CTA inside the article body area
- content ratio:
  - full body is available
  - only teaser or excerpt is accessible
- HTTP / redirect behavior:
  - redirects to login or subscribe pages
  - canonical or response pattern indicates paywall

Important:

- source-root-level generalization is not reliable enough
- the same media site can contain both free and paywalled articles
- therefore the final `Article.isPaywall` should not be derived only from Agent 1 source/feed heuristics

### 7.2 Field overwrite rule

Do not blindly overwrite Agent 1 results.

For every field, keep:

- `raw` value
- `normalized` value
- `chosenValue`
- `chosenFrom`
- `overrideReason`

Example:

- title should remain from the feed if the article HTML title is weaker
- body should come from the article HTML if the feed only had a short excerpt

### 7.3 Structured rejection and skip reasons

Required outcome categories:

- `PAYWALL_BLOCKED`
- `HTTP_FORBIDDEN`
- `HTTP_NOT_FOUND`
- `FETCH_TIMEOUT`
- `LOW_CONTENT_QUALITY`
- `CANONICAL_MISMATCH`
- `DUPLICATE_OR_REDUNDANT`
- `HEADLESS_REQUIRED`
- `UNSUPPORTED_STRUCTURE`

This should not be just a log string. It should be a structured payload field.

Separate rule:

- `PAYWALL_BLOCKED` should only be final when article-level evidence supports it
- feed-level `isPaywall` should remain only an initial hint

## 8. Hard-case queue

Headless support should not be embedded directly inside the normal enrichment batch.

Correct model:

1. Agent 3 attempts HTTP extraction for the article
2. if it is a hard case, it emits `HEADLESS_REQUIRED`
3. a queue entry or dedicated artifact flag is created
4. later a separate hard-case worker processes it

Benefits:

- cost control
- retry control
- clear audit trail
- no slowdown of the normal ingest flow in production

## 9. Artifact strategy

Agent 3 should have its own artifact types.

Recommended artifact types:

- `article_enrichment_attempt`
- `article_enrichment_result`
- `article_enrichment_rejection`
- `article_headless_queue_candidate`

Artifact payload should contain:

- article id
- source/category relationship
- extraction method
- selector / meta results
- field-by-field provenance
- quality metrics
- rejection reason
- timings

### 9.1 Preserve upstream provenance

Agent 3 artifact payload should not hide the upstream discovery context coming from Agent 1.

Minimum expectation:

- it should remain traceable whether the article came from a normal ingest or from a hard-case rerun
- the original source/category target must remain visible
- Agent 1 discovery / feed provenance must remain preserved
- enrichment evidence should be a separate layer, not a replacement for upstream discovery evidence

## 10. DB usage principles

Since DB cost matters in this project, Agent 3 should be designed like this:

- batch queries, not per-article filtering loops
- minimal select fields
- evidence mostly in artifact payloads
- update the article only when there is a real field improvement
- keep retry count and status in cheap fields
- keep the headless queue as a separate layer, not inside every batch

## 11. Security and stability

Required:

- SSRF guard
- same-domain redirect policy
- private IP blocking
- timeout and abort
- HTML sanitization if rich body is stored
- max concurrency limit
- per-run max article limit

## 12. MVP implementation order

### Phase 1

- schema expansion for enrichment states
- HTTP-based extraction
- field comparison and provenance
- enrichment artifact persistence
- structured skip/failure reason
- separate dev trigger

### Phase 2

- retry policy
- source-level extraction heuristics
- quality threshold tuning
- body / title override tuning

### Phase 3

- hard-case queue
- headless worker preparation
- queue deduplication

## 13. Open decision points

- should detailed evidence go into an `Article` JSON field or only into artifacts
- should `bodyText` be overwritten directly, or should a separate enriched field be preferred
- exact list of retryable vs terminal errors
- should the headless queue be a separate table or start as an artifact/meta-based queue

## 14. Final recommendation

The correct role of Agent 3 is:

- cheap and auditable HTTP enrichment
- evidence-based field improvement
- structured failure and hard-case output
- preparation for Agent 4, but not ranking and not lifecycle

Agent 3 will only be stable if it explicitly builds on the Agent 1 artifact / raw / normalized / provenance logic and remains compatible with the hard-case browser fallback + targeted rerun behavior.
