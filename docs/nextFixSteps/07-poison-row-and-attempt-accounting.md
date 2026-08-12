# Repair 07: Poison-Row Isolation and Attempt/Claim Accounting

## Objective

Ensure one malformed or repeatedly failing target/article cannot abort a bounded batch, while making Agent 3 attempt counters represent real extraction ownership rather than selection or failed claim acquisition.

## Prerequisite

Complete Repair 06 first so abandoned ownership and genuine new attempts are distinguishable.

## Scope

Primary areas:

- Agent 1 target loop and per-item feed parsing/persistence
- Agent 2 target and candidate loops
- Agent 3 article selection, claim acquisition, attempt marking, extraction, and persistence
- batch disposition and stage telemetry
- retry limits and terminal/quarantine behavior
- focused failure-injection tests

Do not modify network cooldown policy, charset decoding implementation, article identity constraints, feed productivity thresholds, or 403 circuit behavior.

## Central accounting contract

Define and test the exact points for:

- selected;
- claim attempted;
- claim acquired;
- extraction started;
- durable outcome persisted;
- claim lost;
- retryable failure;
- terminal/quarantined failure.

An `enrichmentAttemptCount` increment must occur only under a durable claim owned by the current worker. Selection, failed claim acquisition, stale token, CAS conflict, governor defer, robots denial, and publisher cooldown must not consume an extraction attempt.

## Required behavior

1. Isolate each source, category, feed item, candidate, and article at the smallest safe boundary.
2. A poison row produces a bounded per-item disposition and does not abort unrelated rows in the batch.
3. Programming/invariant failures that make the whole batch unsafe must still fail loudly; do not catch every exception as ordinary publisher failure.
4. Claim loss and CAS conflict must suppress Article final updates, artifacts, success counters, and persisted-success logs.
5. Persistence exceptions after extraction must follow one documented lease/expiry policy and must not double-increment attempts on replay.
6. Retry limits must have an explicit terminal or quarantine outcome. No row may retry forever without visible state.
7. Batch totals must reconcile exactly with selected item dispositions.
8. Error diagnostics must be bounded and must not contain body text, URLs with queries, credentials, headers, or user identifiers.

## Tests

Add focused tests for:

- malformed row between two valid rows: valid rows still complete;
- feed item parser exception isolation;
- Agent 2 candidate persistence exception isolation;
- failed Agent 3 claim acquisition consumes no attempt;
- governor/robots/cooldown defer consumes no attempt;
- owned extraction increments exactly once;
- claim loss during persistence does not count success or a second attempt;
- persistence exception and replay accounting;
- exact retry boundary transitions to quarantine/terminal state;
- batch disposition reconciliation;
- invariant/programming error remains batch-fatal when continuation is unsafe.

## Acceptance criteria

- No individual poison row can erase unrelated batch progress.
- Attempt count equals actual owned extraction attempts.
- Every selected item has exactly one truthful disposition.
- Retry exhaustion is durable and visible.
- No false-success channel exists in Article state, artifacts, logs, or telemetry.
- Focused tests, Nuxt typecheck, and `git diff --check` pass.

## Safety and validation budget

- Prefer no schema change. Justify a forward-only migration if a durable quarantine/attempt field is genuinely missing.
- No production access, migration deployment, commit, or push.
- Run affected orchestration/runtime/persistence tests only; defer a full suite until the six-repair batch is complete.

## Completion response

Report the accounting state machine, exact increment point, isolation boundaries, terminal retry policy, tests run, migration status, and any exception class that still aborts a batch.
