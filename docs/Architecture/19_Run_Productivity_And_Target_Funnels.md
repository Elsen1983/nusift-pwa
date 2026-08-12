# Run Productivity and Target Funnels

## Identity

Repair 15 keeps two independent identifiers:

- `pipelineRunId` owns an artifact and preserves the existing batch lifecycle.
- `orchestrationRunId` correlates artifacts created by Agent 1, Agent 2 static/headless, and Agent 3 during one daily workflow.

Legacy and manual artifacts may keep `orchestrationRunId = null`. Aggregate stage telemetry remains intentionally unscoped to a source/category.

## Productivity

The run verdict is `productive`, `unproductive`, or `unknown`. Missing telemetry is never coerced to zero. Every metric reports `available`, `stage_absent`, or `metric_unreported`.

Durable insertion, enrichment, or a newly publishable transition makes a run productive. An unproductive verdict requires complete zero evidence for all three output boundaries. The verdict is observation-only and never changes workflow control flow or `runOutcome`.

## Target Funnel

Bounded manifest artifacts record selected source/category targets before stage work. Terminal funnel artifacts are generated from attributed durable artifacts and use a deterministic artifact ID, making workflow replay idempotent.

The finalizer scans at most 2,000 artifacts in 200-row cursor pages. Admin responses contain at most 100 funnels and expose an honest truncation flag. Funnel payloads contain IDs, bounded counters, availability flags, stage names, and closed terminal reasons; they do not store article bodies, headers, cookies, credentials, or URL query values.

Productive evidence has precedence over upstream defer evidence. Missing, conflicting, or truncated evidence becomes `evidence_incomplete` rather than a guessed publisher failure.

## Migration Order

1. Back up the intended database and confirm rollback readiness.
2. Apply `20260812000000_add_pipeline_artifact_orchestration_attribution`.
3. Confirm the nullable column, composite index, and `ON DELETE SET NULL` foreign key exist.
4. Deploy application code.
5. Run one controlled daily workflow.
6. Inspect `/api/dev/run-funnels?orchestrationRunId=<id>` with an authorized admin session.

Do not deploy application code that writes `orchestrationRunId` before the migration is applied.
