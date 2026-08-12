# Repair 05: Agent 2 Headless Cooldown-Aware Eligibility

## Objective

Prevent future-dated publisher cooldowns from making the Agent 2 headless workflow appear permanently stagnant while preserving every retryable queue item.

The workflow must distinguish work that is actionable now from work that remains durable but is not eligible until a bounded future time.

## Verified context

- Agent 2 headless artifacts can remain `PENDING_HEADLESS` while host cooldown evidence prevents browser work.
- Counting every `PENDING_HEADLESS` artifact as immediately eligible can return `processed=0` and an unchanged positive `remainingEligible` value.
- The workflow stagnation guard can interpret that truthful defer as a fatal no-progress condition and prevent Agent 3 from running.
- Feed-first terminal skips and the browser-disabled neutral completion path already exist. Preserve them.

## Scope

Primary areas:

- `server/utils/news-pipeline/article-discovery-headless-queue.ts`
- Agent 2 headless progress/count helpers
- `server/api/internal/run-agent2-headless.post.ts`
- `server/workflows/daily-news-pipeline.ts`
- stage telemetry and admin diagnostics for the headless stage
- focused queue, endpoint, and workflow tests

Do not modify stale claim recovery, Domain Governor lease recovery, Agent 3 attempt accounting, charset handling, article identity, feed productivity state, or 403 policy in this repair.

## Required behavior

1. Define one authoritative distinction between:
   - actionable now;
   - deferred until a known future timestamp;
   - retryable without a known timestamp;
   - claimed/processing;
   - terminal.
2. `remainingEligible` must count only actionable-now work for the current workflow invocation.
3. Durable future work must not be deleted, resolved, or reported as successful.
4. If all remaining work is cooling down, the stage must complete neutrally for the current daily workflow and expose a bounded earliest `nextRetryAt`/`deferredUntil` value.
5. The workflow must continue to Agent 3 instead of sleeping repeatedly or failing for no progress.
6. Expired cooldown evidence must become actionable again without manual database edits.
7. Malformed cooldown evidence must follow an explicit conservative policy and must not cause an infinite defer.
8. Selection must not let old cooling-down rows hide later actionable rows. Use bounded cursor pagination or a queryable durable eligibility field; do not load the whole queue.
9. Cooldown defer is neutral. It must not increment publisher failure, hard-source failure, browser-runtime failure, resolved, or success counters.
10. CAS conflicts and persistence failures must retain truthful unknown-state reporting.

## Design constraints

- Prefer no schema change. If JSON payload filtering cannot provide correct bounded selection, justify a forward-only migration for a queryable `nextEligibleAt` field before changing Prisma.
- Do not use a process-local timer as the authority. Vercel invocations are stateless.
- Do not hold a database transaction while sleeping or performing browser work.
- Preserve the existing request budgets, feed-first policy, robots policy, governor checks, and marker CAS semantics.

## Tests

Add focused tests for:

- only future-cooldown rows remain: current stage completes, Agent 3 is allowed to start, and rows remain durable;
- a mixture of cooling and actionable rows: actionable rows are selected even when older cooling rows exist;
- exact cooldown expiry boundary;
- malformed, missing, and expired timestamps;
- earliest bounded `nextRetryAt` reporting;
- no false success/failure/hard-source side effects;
- CAS conflict and persistence failure;
- pagination exact boundary and scan cap;
- browser-disabled behavior remains neutral;
- feed-first terminal skips remain excluded from active work.

## Acceptance criteria

- A cooling publisher cannot block Agent 3 or fail the daily workflow.
- No retryable marker is lost or falsely resolved.
- `remainingEligible`, `complete`, telemetry, and admin diagnostics use the same authority.
- Actionable work cannot be starved behind deferred rows.
- Focused tests, Nuxt typecheck, and `git diff --check` pass.

## Safety and validation budget

- No production access, migration deployment, commit, or push.
- Run only the affected queue/endpoint/workflow test files during implementation.
- Do not run the full Vitest suite repeatedly. Reserve the full suite for the completion of the six-repair batch unless a cross-cutting regression requires it.

## Completion response

Report the exact eligibility matrix, count/query authority, pagination bounds, defer timestamp semantics, tests run, migration status, and any queue state that remains ambiguous.
