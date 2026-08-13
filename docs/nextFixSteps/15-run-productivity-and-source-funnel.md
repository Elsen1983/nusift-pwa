# Repair 15: Run Productivity Assertion and Per-Source Funnel Attribution

## Objective

Make two operational questions answerable from bounded durable data alone:

1. Did a daily orchestration produce durable article output?
2. At which recorded boundary did a specific source/category target stop producing output?

Repair 11 makes stage degradation truthful. This repair adds an independent productivity signal so a truthful `COMPLETED_PARTIAL` run with zero output cannot look equivalent to one that produced normal output.

## Verified baseline

- Stage telemetry artifacts use the orchestration `PipelineRun.id`, but are batch aggregates and therefore correctly have `sourceId=null` and `categoryId=null`.
- Agent 1 and Agent 2 create separate `PipelineRun` rows per bounded batch. Their per-target artifacts are attached to those batch runs, not directly queryable by orchestration ID.
- Agent 3 receives the orchestration ID as its `pipelineRunId`, so cross-stage attribution currently has inconsistent run identity.
- The current `PipelineArtifact` model has one required `pipelineRunId` relation but no separate indexed orchestration field.
- No single durable artifact currently represents the end-to-end per-target funnel or an orchestration-level productive/unproductive assertion.

## Prerequisites

- Repair 11 must define durable per-stage outcomes.
- Repair 07 must define authoritative per-item dispositions and attempt accounting so funnel counters have one source of truth.

Implement this repair before Repairs 12-14 so later yield changes are measurable against the same baseline.

## Scope

Primary areas:

- orchestration identity propagation through Agent 1/2/3 execution context;
- `PipelineArtifact` orchestration attribution and indexing;
- bounded initial target-manifest evidence;
- terminal per-target funnel artifacts;
- pure run-productivity assertion;
- read-only admin diagnostics and focused attribution tests.

Do not change target selection, stage decisions, extraction/discovery strategy, request budgets, retries, cooldowns, identity/deduplication, publication eligibility, or publisher network behavior. This repair records existing decisions and durable outcomes only.

## Identity model

Use two explicit identities:

- `pipelineRunId`: preserves the existing owning batch/run relation and lifecycle;
- `orchestrationRunId`: nullable cross-stage correlation ID populated for artifacts created under a daily orchestration.

Do not overload or replace `pipelineRunId`. Agent 1/2 batch finalization must not update the orchestration lock row, and Agent 3 must use the same explicit orchestration field even when both IDs happen to be equal.

The likely schema change is a nullable `PipelineArtifact.orchestrationRunId` plus a bounded-query index such as `(orchestrationRunId, sourceId, categoryId, createdAt)`. Confirm relation/delete semantics and existing indexes before creating a forward-only migration. Legacy artifacts remain nullable.

## Attribution rules

1. Thread orchestration ID through Agent 1, Agent 2 static/headless, and Agent 3 contexts without adding publisher requests.
2. Every artifact produced under a daily orchestration carries `orchestrationRunId`.
3. A genuinely single-target artifact carries `sourceId` and nullable `categoryId`.
4. Aggregate stage telemetry remains source/category null by design. Do not falsely assign a multi-target batch to one source.
5. Preserve existing artifact types, statuses, payload contracts, and batch `PipelineRun` summaries.
6. Artifact creation outside the daily workflow may keep `orchestrationRunId=null` unless an explicit orchestration context exists.
7. Avoid per-target orchestration lookup queries inside hot loops; pass the ID through existing function options/context.

## Target manifest

Persist bounded target-scope evidence early enough to distinguish:

- eligible and selected;
- eligible but budget-deferred;
- skipped by feed-first/robots/governor policy;
- never reached because a prior stage degraded/failed;
- not part of this orchestration scope.

Use bounded manifest pages or per-stage target artifacts with deterministic target keys. Do not store unbounded URL lists. The terminal funnel may only claim `stage_not_reached` or `never_selected` when the manifest proves the target belonged to this orchestration.

## Per-target funnel artifact

Write at most one terminal funnel artifact per `(orchestrationRunId, sourceId, categoryId)` target key. Use a schema version and bounded integer counters for evidence that actually exists:

- target in orchestration manifest;
- feed resolved/verified;
- feed items parsed;
- candidate URLs discovered by feed/listing/sitemap/structured/browser origin;
- candidates surviving URL policy;
- candidates evaluated within request budget;
- candidates durably persisted/duplicated/persistence-failed;
- Articles selected/claimed for enrichment;
- Articles durably enriched/failed/deferred/quarantined;
- Articles made publishable in this orchestration.

Do not fabricate unavailable counters. Add an explicit completeness/availability map so zero and unavailable are distinguishable.

## Terminal reason

Store exactly one evidence-derived terminal reason using a closed enum and deterministic precedence. Include at minimum:

- `produced_publishable_articles`;
- `produced_unpublished_articles`;
- `all_duplicates`;
- `feed_missing_or_invalid`;
- `feed_unverified`;
- `feed_first_waiting_evidence`;
- `robots_disallowed`;
- `host_cooldown`;
- `governor_deferred`;
- `budget_deferred`;
- `url_policy_rejected_all`;
- `no_candidates_found`;
- `enrichment_failed`;
- `enrichment_deferred`;
- `quarantined`;
- `stage_not_reached`;
- `evidence_incomplete`.

Define precedence as a pure function. A productive terminal reason wins over upstream nonterminal evidence. Unknown or conflicting evidence becomes `evidence_incomplete`, never a guessed publisher failure.

## Persistence and lock behavior

1. Build funnels from attributed durable artifacts/dispositions, not in-memory pre-persistence candidate counts.
2. Write funnel artifacts in bounded pages with `createMany`/upsert-equivalent idempotency and a deterministic unique identity.
3. Funnel generation is observation-only: failure does not change stage/run decisions, but is recorded as incomplete diagnostics.
4. Funnel writes may occur before orchestration finalization but must have strict row/time caps and no publisher I/O. Do not claim they take zero lock time.
5. Workflow replay must not create duplicate terminal funnel artifacts.

## Run productivity assertion

Define a pure, total function over reconciled funnel/run summary data. Record at least:

- `productive`: boolean;
- Articles inserted in this orchestration;
- Articles durably enriched in this orchestration;
- Articles made publishable in this orchestration;
- deepest productive funnel boundary;
- evidence completeness;
- number of productive, unproductive, and unattributable targets.

A run is `unproductive` when it produced no durable insert, enrichment, or newly publishable transition. Keep this independent from `COMPLETED`, `COMPLETED_PARTIAL`, and `FAILED`; it is a signal, never retry/control flow.

Consecutive unproductive runs must be queryable with a bounded indexed run lookup and summary inspection. Do not scan all historical artifacts.

## Admin diagnostics

Provide a read-only, authorization-protected, cursor-paginated view that can answer:

- the productivity assertion for one orchestration;
- the per-target funnel and terminal reason;
- whether evidence is complete, partial, truncated, or unavailable;
- consecutive recent unproductive orchestration count.

Do not expose raw URLs with queries, bodies, headers, cookies, credentials, IP addresses, or user identifiers.

## Tests

Cover:

- Agent 1/2/3 artifacts share the explicit orchestration ID while preserving batch `pipelineRunId`;
- multi-source stage telemetry intentionally remains source/category null;
- single-target artifacts carry source/category attribution;
- manifest distinguishes never selected, deferred, policy-skipped, and stage-not-reached;
- productive source funnel counters reconcile with Repair 07 dispositions;
- duplicate-only and no-candidate targets receive distinct reasons;
- deterministic terminal-reason precedence and conflict fallback;
- zero-output run is marked unproductive;
- inserted, enriched, or newly publishable output marks the run productive even if another stage degraded;
- unavailable evidence is not treated as zero;
- funnel write failure leaves run control flow unchanged but marks diagnostics incomplete;
- replay/idempotency produces one funnel artifact per target;
- cursor pagination, exact boundaries, scan caps, authorization, and redaction;
- one bounded query returns the cross-stage story for one source/category and orchestration.

## Acceptance criteria

- A bounded indexed query by orchestration/source/category returns the cross-stage target story.
- Every manifest target that produced no output has one stored evidence-derived reason or explicit incomplete-evidence reason.
- Every orchestration carries an independent productive/unproductive assertion.
- Counters are persistence-aware and reconcile with authoritative dispositions.
- No pipeline decision or publisher request behavior changes.
- Focused tests, Prisma validate/generate, migration static and localhost-only integration tests when applicable, Nuxt typecheck, and `git diff --check` pass.

## Safety and validation budget

- Forward-only migration only; never rewrite applied migration history.
- No production migration/access, commit, or push.
- Run only affected telemetry, artifact, orchestrator, discovery, enrichment, workflow, and admin tests.
- Reserve the full suite for tranche completion.

## Completion response

Report the two-ID model, schema/index/migration status, manifest authority, funnel counters and availability flags, terminal-reason enum/precedence, productivity formula, bounded diagnostic query, tests run, and any stage boundary still not attributable.
