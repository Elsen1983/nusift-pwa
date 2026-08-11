# Admin observability

## Purpose

The admin audit page exposes stage controls next to the evidence they affect. It is an operational diagnostic surface, not a substitute for durable pipeline state.

## Main views

- Agent 1 run summary and progress/deferred targets.
- Agent 2 discovery quality, headless queue, hard sources, profiles, lifecycle, and health.
- Agent 3 run summary, progress, browser/source cooldowns, and rejection diagnostics.
- Maintenance dry-run/delete summaries.
- Agent logs at the bottom for cross-stage chronology.

## Reporting rules

- Distinguish zero new inserts with an active RSS feed from a fetch/parse failure.
- Distinguish latest-run diagnostics from historical/all-run views.
- Display retryable, blocked, cooling-down, non-retryable, and completed counts explicitly.
- Do not label extracted candidates as persisted success when database writes failed.
- Admin endpoints remain authenticated, rate-limited, bounded, and compact.

## Graphify entry points

- [[Graphify/admin.vue.md|admin.vue]]
- [[Graphify/refreshDevPanel().md|refreshDevPanel]]
- [[Graphify/servicesadmin-inspection.ts.md|admin inspection service]]
- [[Graphify/rejection-diagnostics-normalizer.ts.md|rejection diagnostics normalizer]]

#nusift #admin #observability #audit
