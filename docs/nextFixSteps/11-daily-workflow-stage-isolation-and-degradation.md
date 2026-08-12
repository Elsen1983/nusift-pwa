# Repair 11: Daily Workflow Stage Isolation and Degradation

## Objective

Ensure that a non-safety stage failure or genuine no-progress condition becomes a truthful per-stage degraded/failed outcome instead of aborting every later daily-pipeline stage.

Repair 05 removes false headless cooldown stagnation at its source. This repair defines what the workflow does when a stage still cannot complete after its bounded retry policy.

## Verified context

- `runDailyNewsPipelineWorkflow()` currently wraps the full stage loop in one outer `try`.
- The stagnation terminal branch throws `FatalError`, so an Agent 1 or Agent 2 failure prevents all later stages from running.
- Agent 3 is excluded from the one-time stagnation backoff used by the other stages.
- `postInternalRunner()` has no bounded request timeout.
- The Agent 2 headless-disabled route now returns an explicit successful neutral response; it no longer requires generic HTTP 503 to mean "skip".

## Prerequisite

Complete Repair 05 first so actionable-now versus future-deferred work uses one authority.

## Scope

Primary areas:

- `server/workflows/daily-news-pipeline.ts`
- `postInternalRunner()` timeout and HTTP status classification
- workflow result and durable run-summary payloads
- stage telemetry and read-only admin diagnostics
- focused workflow/internal-runner tests

Do not change stage ordering, batch sizing, target selection, cooldown eligibility, claim recovery, attempt accounting, charset handling, article identity, feed-productivity policy, or Domain Governor circuit rules.

## Outcome state machine

Define exactly these stage outcomes:

- `completed`: the stage drained all work actionable in this invocation, including an explicit neutral skip or only-future-deferred result;
- `degraded`: the stage made durable progress or reached a bounded no-progress condition, but could not drain all actionable work;
- `failed`: the stage could not produce trustworthy progress because its bounded runner/retry path failed.

Define run outcomes:

- `COMPLETED`: every stage completed;
- `COMPLETED_PARTIAL`: at least one stage completed or degraded and at least one stage was degraded/failed;
- `FAILED`: an explicitly unsafe fatal condition occurred, or no stage reached completed/degraded.

An unsafe fatal condition remains `FAILED` even if earlier stages wrote durable data. Preserve that partial work in diagnostics.

## Required behavior

1. Execute each stage inside its own bounded error boundary.
2. A stagnation verdict receives the same one-time bounded backoff for Agent 3 as for other stages, then becomes `degraded` rather than throwing a run-fatal error.
3. A nonfatal internal runner error that exhausts its workflow retry policy becomes stage `failed`; later stages still run.
4. "Only future-deferred work remains" is stage `completed` with a bounded `nextRetryAt`, not degraded.
5. Explicit successful route responses may declare a neutral skip. Generic HTTP 503 must not be treated as a neutral skip; it remains retryable and may eventually produce stage `failed`.
6. Enumerate run-fatal conditions narrowly: lost workflow ownership/lock, missing internal-runner configuration, authentication/authorization failure, endpoint/contract mismatch, or another proven invariant that makes continuation unsafe.
7. Apply a bounded `AbortSignal.timeout()` to internal runner requests. Classify timeout as retryable and eventually stage-failed, not publisher evidence.
8. Preserve the original bounded diagnostic for every degraded/failed stage without URLs containing queries, secrets, bodies, or user identifiers.
9. Record exactly one outcome per stage with reason, batch count, elapsed time, remaining/actionable counts, and earliest deferred timestamp when known.
10. Continue final Agent 3 completion summary only when doing so is safe; its diagnostic failure must remain observation-only.
11. Preserve deterministic workflow replay and existing lock/heartbeat behavior.

## HTTP/result classification

Implement and test an explicit table:

- valid 2xx completed body: normal stage result;
- valid 2xx explicit neutral skip: completed with skip reason;
- 400/404 or invalid response contract: fatal configuration/contract failure;
- 401/403 from internal endpoints: fatal authentication/authorization failure;
- 408/429/500/502/503/504 and transport timeout: retryable runner failure, then stage `failed` after bounded exhaustion;
- malformed 2xx body: fatal contract mismatch.

Do not infer neutral skip from an HTTP status alone.

## Tests

Add focused tests for:

- Agent 1 stagnation: later Agent 2 and Agent 3 stages execute; run is `COMPLETED_PARTIAL`;
- Agent 2 headless stage failure: Agent 3 still executes;
- Agent 3 stagnation uses one bounded backoff before degradation;
- every stage stagnates/degrades: run is `COMPLETED_PARTIAL`, not `FAILED`;
- every stage runner fails without trustworthy progress: run is `FAILED`;
- all stages complete: existing `COMPLETED` behavior remains;
- only future-deferred work is completed with `nextRetryAt`;
- explicit browser-disabled 2xx skip is completed;
- generic 503 is retryable, never a neutral skip;
- 400/401/403/404 and malformed success payload remain fatal;
- internal fetch timeout classification;
- lock loss remains fatal;
- exactly one summary outcome exists per stage;
- deterministic replay/resume behavior.

## Acceptance criteria

- No non-safety failure in one stage can prevent Agent 3 from running.
- A run that performed useful work and then degraded is not falsely reported as fully completed or fully failed.
- Unsafe conditions remain explicitly fatal.
- Stage and run outcomes are internally consistent and durably observable.
- Focused workflow/internal endpoint tests, Nuxt typecheck, workflow bundle verification, and `git diff --check` pass.

## Safety and validation budget

- No production access, migration, commit, or push.
- Run only affected workflow and internal-endpoint tests during implementation.
- Do not repeatedly run the full Vitest suite.

## Completion response

Report the stage/run state machine, fatal-condition set, HTTP/result classification, timeout bound, tests run, and any failure whose classification remains uncertain.
