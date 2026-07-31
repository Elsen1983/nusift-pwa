# NuSift Agent 1–3 Remediation Plan

## 1. Objective

The remediation should make the NuSift content pipeline:

- safe under concurrent execution;
- resistant to partial failures;
- explicit about the distinction between a discovered candidate and a publishable Article row;
- idempotent across retries;
- accurate about upstream provenance;
- unable to report success when database persistence failed;
- verifiable through real PostgreSQL integration and concurrency tests.

The work should be delivered in dependency-aware phases. Immediate containment should precede schema-heavy changes.

## 2. Priority Model

No confirmed destructive P0 issue was identified in the Agent 1–3 flow.

The following are P1 and should be treated as release-blocking for strong data-integrity guarantees:

1. Agent 3 has no Article claim or lease.
2. Agent 2 can resolve state before candidate persistence succeeds.
3. Headless Agent 2 can report `RESOLVED` after persistence failure.
4. The user feed exposes incomplete or failed Articles.
5. Agent 3 can write incorrect upstream provenance.
6. Agent 1/2/3 runs can overlap without general locking.
7. Agent 2 deferred targets can starve valid current targets.
8. Valid RSS feeds can be classified as nonproductive when all items are duplicates.
9. Source creation starts unbounded fire-and-forget ingestion.
10. An Article can retain only one category.

## 3. Phase 0 — Immediate Containment

Phase 0 is temporary operational containment, not the final implementation of the controls described in later phases. It should reduce exposure while the durable fixes are being developed and validated.

### 3.1 Restrict unsafe execution paths

Until the structural fixes are complete:

- Keep Agent 3 browser fallback disabled for unattended execution; Agent 3 is currently manual/admin-driven, so this protects against accidental future automation rather than changing an existing Agent 3 cron job.
- Disable the legacy unbounded `runNewsPipeline` path for user-created sources.
- Route new source/category processing through bounded Agent 1 execution.
- Temporarily prevent manual runs from overlapping scheduled runs where possible.
- Keep Agent 3 manual, bounded, and rate-limited.

**Acceptance criteria:**

- No user request launches an unbounded ingestion process.
- Every run has a durable `PipelineRun` ID.
- Every run is bounded by target/article count and time budget.
- Browser fallback is not enabled automatically by cron.

### 3.2 Stop false terminal success states

Change Agent 2 state handling so that:

- static discovery does not resolve old headless markers before candidate persistence succeeds;
- headless work becomes `RESOLVED` only when persistence has succeeded;
- persistence failures use a retryable state such as `PERSISTENCE_FAILED_RETRYABLE`.

**Acceptance criteria:** A simulated database failure during candidate insertion leaves the target retryable, records a failure artifact, and does not resolve the old marker.

## 4. Phase 1 — Agent 3 Claims and Concurrency Safety

### 4.1 Add Article claims or leases

Add Article-level claim fields:

```text
enrichmentClaimToken
enrichmentClaimedAt
enrichmentLeaseExpiresAt
enrichmentClaimOwner
```

Define the lease duration explicitly (for example, longer than the maximum configured extraction timeout plus a recovery margin). Generate a cryptographically random claim token and record the worker/run identifier in `enrichmentClaimOwner`. Use a separate `ArticleEnrichmentAttempt` model instead if detailed attempt history is preferred.

Claim with a compare-and-set update:

```text
UPDATE Article
SET enrichmentStatus = 'ENRICHING',
    enrichmentClaimToken = :token,
    enrichmentClaimedAt = now(),
    enrichmentLeaseExpiresAt = :leaseExpiry,
    enrichmentClaimOwner = :owner
WHERE id = :articleId
  AND enrichmentStatus IN ('INGESTED', 'ENRICHMENT_FAILED')
  AND (
    enrichmentLeaseExpiresAt IS NULL
    OR enrichmentLeaseExpiresAt < now()
  )
```

Only the worker that successfully claims the row may process it.

### 4.2 Protect final writes

The final Article update must require:

- Article ID;
- matching claim token;
- `enrichmentStatus = 'ENRICHING'`.

If zero rows are updated, the worker has lost its claim. It must not write a successful final artifact or overwrite the Article.

### 4.3 Recover expired claims

Add maintenance logic that:

- finds expired `ENRICHING` rows;
- moves them back to `INGESTED` or `ENRICHMENT_FAILED`;
- records a recovery artifact;
- increments a recovery count;
- prevents immediate infinite retries.

**Acceptance criteria:**

- Two workers cannot claim the same Article.
- A stale worker cannot overwrite a newer success.
- Expired claims are recoverable.
- Attempt counts remain correct.
- Article and final outcome artifact remain consistent.

## 5. Phase 2 — Agent 2 Persistence and Handoff Integrity

### 5.1 Reorder static discovery operations

Use the following terms consistently:

- **Candidate:** an accepted URL/result discovered by Agent 1 or Agent 2 before publication approval.
- **Article row:** the database row created to store that candidate and its current processing state.
- **Publishable Article:** an Article row that satisfies the publication policy and may be returned by the user feed.

Use this order:

1. Run discovery.
2. Persist candidate Articles.
3. Verify the persistence result.
4. Persist the discovery artifact.
5. Resolve old headless markers only after persistence succeeds.
6. Update lifecycle state.
7. Finalize the PipelineRun.

If persistence fails, the target remains retryable. If Article persistence succeeds but artifact persistence fails, the Article write must remain idempotently detectable on retry, and the run must record an explicit `ARTIFACT_PERSISTENCE_FAILED` state rather than reporting full success. A retry must not create a duplicate Article.

### 5.2 Use persistence-aware states

Do not use `RESOLVED` for both “candidates found” and “Articles stored.” Recommended states:

```text
DISCOVERY_CAPTURED
PERSISTENCE_PENDING
PERSISTENCE_FAILED_RETRYABLE
RESOLVED
```

For headless processing:

```text
HEADLESS_PROCESSING
BROWSER_CANDIDATES_CAPTURED
BROWSER_PERSISTENCE_FAILED
RESOLVED
```

### 5.3 Make state transitions consistent

Where practical, put the following database writes in one transaction:

- Article persistence;
- target outcome update;
- marker resolution;
- persistence-confirmation artifact.

Never include network fetching, browser work, or extraction in the transaction. Large candidate batches may also make one transaction impractical; in that case, use the durable `PERSISTENCE_PENDING` state machine and make each transition idempotent.

**Acceptance criteria:** Failure-injection tests cover Article insert failure, artifact failure, marker-update failure, partial `createMany`, retry, and duplicate retry.

## 6. Phase 3 — Publication Safety

### 6.1 Add an explicit publication state

Minimum-change option: add `publicationStatus` to Article.

For existing rows, define a migration default and an explicit backfill policy before enabling the feed filter. For example, legacy rows may initially be marked `CANDIDATE` and promoted only after validation, or a one-time audited backfill may classify already trusted rows as `PUBLISHED`. Do not deploy a filter without deciding how legacy rows are handled.

Suggested values:

```text
CANDIDATE
ENRICHMENT_PENDING
PUBLISHED
REJECTED
WITHHELD
```

Preferred long-term option: introduce an `ArticleCandidate` model and promote candidates to Article records only after quality gates pass.

### 6.2 Gate the user feed

Update `server/api/feed.ts` to exclude nonpublishable states. The user feed should not return:

- `CANDIDATE`;
- `ENRICHMENT_PENDING`;
- `ENRICHMENT_FAILED`;
- `REJECTED`;
- `WITHHELD`;
- invalid or missing canonical URLs.

Admin diagnostics must continue to expose candidates and failures.

**Acceptance criteria:** Newly ingested, failed, and rejected Articles do not appear in the user feed unless the publication policy explicitly allows them.

## 7. Phase 4 — Provenance Corrections

### 7.1 Remove false defaults

Replace `feedOrigin: "rss"` fallback with an explicit `unknown` value or nullable field.

Do not infer:

- RSS origin from the existence of an Article row;
- category-feed discovery from `categoryId` alone;
- hard-case rerun status without evidence.

### 7.2 Recover Agent 1 and Agent 2 provenance

Agent 3 should search:

- Agent 1 `rss_candidates` artifacts;
- Agent 2 `article_discovery_candidates` artifacts;
- browser discovery artifacts;
- hard-case rerun artifacts;
- producing pipeline runs.

Persist stable references where possible:

```text
originArtifactId
originPipelineRunId
originAgent
originMethod
```

### 7.3 Preserve extraction-method provenance

Record the actual body source:

```text
dom
expanded-dom
readability
browser-dom
existing-fallback
```

Do not label Readability output as DOM output.

**Acceptance criteria:** Unknown origin remains unknown, Agent 2 Articles are identifiable, and extraction methods are accurately represented in artifacts.

## 8. Phase 5 — Distributed Run Locks

Phase 0 may temporarily suppress overlapping manual and scheduled executions. Phase 5 replaces that operational workaround with durable, enforceable locking.

### 8.1 Add agent-level locks

Use PostgreSQL advisory locks or a durable lease table for:

```text
nusift:agent1
nusift:agent2
nusift:agent3
nusift:agent2-headless
```

The lock implementation must support acquisition, expiry or safe release, diagnostics, and manual recovery. A lock holder must have an owner/run ID, a lease expiry, and a recovery rule for abandoned locks.

### 8.2 Add target/Article protection

Agent-level locks should be supplemented with:

- Agent 1 target claims;
- Agent 2 target claims;
- Agent 3 Article claims.

**Acceptance criteria:** Overlapping runs are rejected or safely isolated, and lock events are observable.

## 9. Phase 6 — Scheduling and Feed Productivity

### 9.1 Fix deferred-target starvation

Change `prioritizeDeferredTargets` to:

1. prioritize eligible deferred targets;
2. append current non-deferred eligible targets;
3. fall back to the full current target list when no deferred target remains eligible;
4. mark stale deferred artifacts superseded.

**Acceptance criteria:** A newly eligible Agent 2 target is processed even when prior deferred targets have become ineligible.

### 9.2 Correct RSS productivity semantics

Track these independently:

```text
feedFetchSucceeded
feedParseSucceeded
validItemsFound
freshItemsFound
inScopeItemsFound
newArticlesInserted
duplicatesSkipped
```

A valid feed remains productive when it returns valid in-scope content, even if every item is already stored.

**Acceptance criteria:** Duplicate-only valid RSS runs remain RSS-owned and do not trigger Agent 2 solely because `inserted === 0`.

## 10. Phase 7 — Durable Source-Processing Jobs

Replace fire-and-forget processing in `server/api/user/sources/add.post.ts` with:

1. Create/update source or category.
2. Create a durable targeted PipelineRun/job.
3. Return the job/run ID.
4. Process through bounded Agent 1 execution.
5. Expose durable progress and failure state.

The API response must distinguish source creation from article-ingestion completion.

Suggested states:

```text
SOURCE_CREATED_PIPELINE_QUEUED
SOURCE_CREATED_PIPELINE_RUNNING
SOURCE_CREATED_PIPELINE_COMPLETED
SOURCE_CREATED_PIPELINE_FAILED
```

**Acceptance criteria:** The job is not lost if the HTTP request ends, and failures remain visible and retryable.

## 11. Phase 8 — Category Model Correction

### 11.1 Add many-to-many Article/category relations

Add an `ArticleCategory` join model with:

```text
articleId
categoryId
createdAt
unique(articleId, categoryId)
```

Retain `Article.categoryId` temporarily as a legacy or primary category if necessary.

### 11.2 Backfill safely

Use:

- existing Article category IDs;
- canonical URL paths;
- Agent 1/2 provenance artifacts;
- discovery target information.

Do not create associations where evidence is ambiguous. Record ambiguous cases for review.

### 11.3 Update all readers and writers

Update Agent 1, Agent 2, feed queries, analytics, cleanup, and article detail paths.

**Acceptance criteria:** Valid articles appear under all supported categories and duplicate ArticleCategory relations are impossible.

## 12. Phase 9 — Deduplication Hardening

### 12.1 Detect identity conflicts

If RSS GUID, canonical URL, and content hash point to different Article IDs:

- do not silently choose one;
- create an identity-conflict artifact;
- avoid applying metadata arbitrarily;
- make the Article retryable or reviewable.

### 12.2 Define identity precedence

Recommended precedence:

1. verified canonical URL;
2. trusted publisher GUID;
3. content hash as supporting evidence only.

Make publisher-specific trust configurable where necessary.

**Acceptance criteria:** Tests cover reused GUIDs, changed canonical URLs, hash collisions, and concurrent inserts.

## 13. Phase 10 — Observability

Add structured events for:

- lock acquired/rejected/released;
- Article claimed/released/recovered;
- candidate persistence started/completed/failed;
- marker resolution deferred/completed;
- publication promoted/rejected;
- provenance recovered/unknown;
- identity conflict detected;
- stale-worker write rejected;
- deferred target superseded.

Each event should include:

```text
agent
pipelineRunId
sourceId
categoryId
articleId
targetUrl
phase
status
retryable
errorCode
```

Replace empty catches in legacy orchestration with target-specific structured failure records.

## 14. Testing Strategy

### 14.1 Unit tests

Add tests for:

- Agent 3 claim predicates;
- expired claim recovery;
- stale final-write rejection;
- persistence-aware Agent 2 marker resolution;
- headless persistence-failure states;
- deferred-target fallback;
- duplicate-only RSS productivity;
- unknown provenance;
- identity conflicts;
- publication filtering;
- multi-category matching.

### 14.2 PostgreSQL integration tests

Use a real test database to verify:

- unique constraints;
- `createMany({ skipDuplicates: true })`;
- transaction rollback;
- concurrent Article inserts;
- concurrent Agent 3 claims;
- conditional final updates;
- advisory locks or lease expiry;
- marker/Article state consistency.

### 14.3 End-to-end production-path tests

The minimum flow is:

```text
authenticated route
→ target resolution
→ feed/discovery fetch
→ candidate artifact
→ Article persistence
→ Agent 3 claim
→ extraction outcome
→ Article/artifact transaction
→ publication promotion
→ user feed query
```

Inject failures at every database write boundary.

### 14.4 Mandatory regression scenarios

- Two Agent 3 runs process one Article.
- One Agent 3 run succeeds while another stale run fails.
- Agent 2 persistence fails after discovery succeeds.
- Headless persistence fails after browser discovery.
- Agent 1 receives only duplicate RSS items.
- A deferred Agent 2 target becomes ineligible.
- A new Agent 2 target appears alongside stale deferred artifacts.
- Source creation returns before processing completes.
- One Article belongs to multiple categories.
- Admin can inspect a candidate while the user feed correctly hides it.

## 15. Rollout Plan

### Release 1 — Containment

- Disable unsafe fire-and-forget execution.
- Prevent false `RESOLVED` states.
- Add a temporary publication safety filter using the existing status fields; defer the final `publicationStatus` schema and migration to Phase 3/Release 4.
- Add temporary operational overlap protection.
- Add P1 regression tests for the containment behavior.

### Release 2 — Concurrency and provenance

- Add Agent 3 claims and leases.
- Add stale-write protection.
- Correct provenance fallback.
- Add Agent 2 provenance recovery.
- Add claim recovery maintenance.

### Release 3 — Scheduling and deduplication

- Fix deferred-target starvation.
- Correct feed productivity semantics.
- Add identity-conflict handling.
- Remove the unbounded legacy execution path.

### Release 4 — Schema improvements

- Add publication lifecycle fields or `ArticleCandidate`.
- Add many-to-many Article/category relations.
- Backfill existing data with audit reporting.

### Release 5 — Verification

- Run PostgreSQL concurrency tests.
- Run end-to-end pipeline tests.
- Compare duplicate, retry, false-success, publication, and provenance metrics before and after rollout.
- Only then consider expanding unattended browser or Agent 3 automation.

## 16. Definition of Done

The definition of done applies to the final durable implementation, not merely the temporary Phase 0 containment measures.

The remediation is complete when:

- no Agent 3 Article is processed concurrently without a claim;
- stale workers cannot overwrite newer outcomes;
- Agent 2 never resolves a target after persistence failure;
- the user feed excludes nonpublishable records;
- unknown provenance is represented as unknown;
- overlapping runs are prevented or safely rejected;
- deferred Agent 2 targets cannot starve current eligible targets;
- duplicate-only valid RSS runs remain RSS-productive;
- source ingestion is durable and bounded;
- all valid Article/category relationships are preserved;
- identity conflicts are observable;
- real PostgreSQL integration and concurrency tests pass;
- Prisma validation, TypeScript checks, and the full test suite pass.
