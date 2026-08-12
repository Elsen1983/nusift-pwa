# Poison-Row Isolation and Attempt Accounting

## Agent 3 accounting authority

`claimEnrichmentArticle` atomically acquires the unique article lease and
provisionally increments `Article.enrichmentAttemptCount`. A failed claim or
stale selection CAS rolls the transaction back and consumes no attempt.

A governor denial or authoritative browser 429 is a neutral defer. The worker
uses its token, unexpired lease, exact attempt number, article count CAS, and
pipeline-run identity to atomically:

1. decrement the provisional attempt;
2. delete the owned claim;
3. delete the owned `ATTEMPTED` marker when it exists.

If this rollback cannot be proven, the lease and count are retained until
expiry recovery and the selected item is reported as `persistenceFailed`, not
as deferred. This prevents replay from double-decrementing or stealing a newer
owner.

## Selected-item dispositions

`buildAgent3BatchDispositions` is the authority for the mutually exclusive
selected-article buckets:

- succeeded;
- retryable failure;
- permanent failure;
- skipped, including failed claim acquisition and source cooldown;
- deferred, including neutral governor deferral;
- quarantined;
- claim lost;
- persistence failed.

The bucket sum must equal `selectedCount`. A mismatch is an `InvariantError`
and remains batch-fatal. The internal Agent 3 endpoint consumes this object
directly instead of reconstructing counters from partial evidence.

## Isolation boundaries

- Agent 1 and Agent 2 isolate ordinary source/target failures and continue the
  bounded batch.
- Feed entry normalization isolates malformed individual entries.
- Candidate `createMany` failure falls back to sequential bounded persistence;
  valid neighbours survive, `P2002` is a retry-safe skip, and only the poison
  candidate is failed.
- Agent 3 persists every owned outcome in its own transaction. An ordinary
  persistence exception fails that selected article and leaves its claim for
  normal expiry recovery.
- Type, reference, syntax, range, assertion, and explicit invariant errors are
  never downgraded to publisher failures.

## Retry terminal policy

The existing Agent 3 retry authority remains unchanged: retryable outcomes use
the bounded retry schedule and transition to `QUARANTINED` at the configured
attempt boundary. Non-retryable outcomes remain terminal. Neutral policy
deferrals consume no attempt.

## Diagnostics

Per-item errors are capped at 300 characters. URL query values and common
credential fields are redacted. Article bodies, headers, cookies, credentials,
and user identifiers are not persisted in these diagnostics.

No schema change or migration is required for this repair.
