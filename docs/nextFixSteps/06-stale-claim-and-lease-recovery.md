# Repair 06: Stale Claim and Lease Recovery Integration

## Objective

Wire the existing stale Agent 2 claim and expired Domain Governor lease recovery capabilities into bounded, observable workflow execution so process crashes do not leave work permanently unavailable.

## Verified context

- Recovery helpers exist for stale Agent 2 headless processing and expired domain leases.
- Existing helper-level coverage does not prove that normal scheduled execution invokes them.
- Recovery must be safe under multiple concurrent workers and must never overwrite a live owner.

## Prerequisite

Complete Repair 05 first. This repair handles abandoned ownership, not publisher cooldown eligibility.

## Scope

Primary areas:

- `recoverStaleArticleDiscoveryHeadlessProcessing`
- `recoverExpiredDomainLeases`
- daily workflow startup or bounded maintenance stages
- workflow lock/heartbeat integration
- recovery telemetry and read-only admin diagnostics
- focused recovery and concurrency tests

Do not change publisher cooldown calculation, Agent 3 attempt limits, charset decoding, article deduplication, feed productivity demotion, or 403 circuit policy.

## Required behavior

1. Audit every claim/lease state and document its authoritative owner token, expiry field, and recoverable transition.
2. Invoke recovery from a deterministic scheduled path before the affected work is selected.
3. Recovery must be bounded by explicit scan, update, and wall-clock limits.
4. Use token/status/version/expiry CAS. A live or renewed owner must never be recovered.
5. Agent 2 stale processing may return to the correct retryable queue state only when ownership is proven expired.
6. Expired Domain Governor leases may be released without changing circuit state, cooldown, streaks, or network outcome evidence.
7. Recovery must be idempotent. Two recovery workers may race, but only one may mutate each row.
8. Recovery failure must not be reported as recovered work and must not silently unblock unsafe network activity.
9. Recovery telemetry must distinguish scanned, recovered, conflicted, malformed, and failed rows.
10. Shadow/off governor modes must preserve their existing no-coordination semantics.

## Integration decision

Choose and justify one bounded authority:

- a small recovery step at daily workflow startup;
- recovery immediately before the relevant Agent 2/Domain Governor selection;
- or both, only if they are idempotent and do not duplicate expensive scans.

Do not introduce a second independent scheduler without proving lock and retry behavior.

## Tests

Add focused tests for:

- stale Agent 2 claim recovery;
- active Agent 2 claim rejection;
- claim renewed between read and update;
- expired Domain Governor lease recovery;
- active/renewed lease rejection;
- stale token cannot release a newer lease;
- two concurrent recovery workers produce one winner;
- malformed legacy rows remain visible and bounded;
- recovery persistence failure is reported truthfully;
- workflow invokes recovery before selection;
- repeated workflow invocation is idempotent.

If current PostgreSQL integration infrastructure is available, add or extend an opt-in localhost-only test using independent clients. Do not weaken localhost and explicit opt-in gates.

## Acceptance criteria

- Crash-abandoned ownership becomes eligible again without manual database edits.
- Live ownership cannot be stolen.
- Recovery is bounded, idempotent, CAS-protected, and observable.
- Recovery does not alter publisher outcome, circuit, cooldown, or hard-source semantics.
- Focused tests, Prisma validation/generation when applicable, Nuxt typecheck, and `git diff --check` pass.

## Safety and validation budget

- No production recovery execution, migration deployment, commit, or push.
- Do not run the full Vitest suite repeatedly.
- Clearly label mock concurrency separately from real PostgreSQL concurrency.

## Completion response

Report every recovered state transition, invocation point, bounds, CAS predicates, concurrency evidence, PostgreSQL verification status, and unrecoverable legacy state.
