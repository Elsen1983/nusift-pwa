# Stale Claim and Lease Recovery

## Authority

The daily workflow owns one bounded startup recovery step. It runs after the
daily `PipelineRun` lock is acquired and before Agent 1 selects network work.
It does not have a separate scheduler.

## Ownership matrix

| State | Owner proof | Expiry authority | Recoverable transition | Recovery point |
| --- | --- | --- | --- | --- |
| Agent 2 `HEADLESS_PROCESSING` artifact | `PipelineArtifact.headlessClaimToken` | `headlessClaimExpiresAt` | `HEADLESS_PROCESSING` to `PENDING_HEADLESS` | Daily startup recovery |
| Domain Governor request lease | `activeLeaseToken` plus `version` | `activeLeaseExpiresAt` | Clear only the lease fields and increment `version` | Daily startup recovery in `enforce` mode |
| Agent 3 article claim | `ArticleEnrichmentClaim.token` | `expiresAt` | Delete the expired claim row | Existing Agent 3 preselection recovery |
| Robots refresh lease | `PublisherRobotsPolicy.activeLeaseToken` plus `version` | `activeLeaseExpiresAt` | Refresh acquisition or token-owned completion | Existing robots-policy refresh path |
| Daily workflow lock | running `PipelineRun` row under advisory-lock acquisition | `updatedAt` heartbeat age | Mark stale before replacement acquisition | Existing workflow lock acquisition |

Browser navigation uses the Domain Governor lease and therefore has no second
lease-recovery authority.

## Agent 2 CAS contract

Claim acquisition changes `PENDING_HEADLESS` to `HEADLESS_PROCESSING` and writes
a random token plus a 30-minute expiry. Every worker-owned terminal or deferred
transition requires the same artifact ID, status, and token, then clears both
claim fields.

Recovery selects only expired scalar leases. Its update requires the selected
artifact ID, `HEADLESS_PROCESSING` status, exact token, and exact expiry. A
renewal, terminal transition, or competing recovery therefore produces a CAS
conflict instead of stealing ownership.

Legacy processing rows without either scalar claim field are reported as
`malformed` and left unchanged. They require explicit operator review because
no authoritative owner token exists.

## Domain Governor contract

Expired leases are released with domain key, exact token, exact version, and
exact expiry CAS. Recovery clears only `activeLeaseToken` and
`activeLeaseExpiresAt`, then increments `version`. Circuit state, cooldown,
request deadline, streaks, and HTTP evidence are not changed.

`off` and `shadow` modes remain database-free no-ops. An `enforce` persistence
failure does not claim recovery; normal permit acquisition remains fail-closed.

## Bounds and telemetry

- Agent 2: maximum 10 expired claims per daily startup, a separately bounded
  malformed scan of `min(limit, 20)`, and a cooperative 5-second mutation budget.
- Domain Governor: maximum 100 expired leases, cooperative 5-second mutation
  budget.
- Both paths report scanned, recovered, conflicted, malformed, failed, and
  time-budget-exhausted counts.
- The workflow stores a bounded `stale_claim_recovery_telemetry` artifact and
  copies the summary into the terminal daily workflow summary.
- The read-only admin telemetry endpoint exposes these counters.

## Deployment order

1. Apply `20260812120000_add_headless_artifact_claim_lease`.
2. Deploy the application code.
3. Confirm the next daily workflow contains startup recovery telemetry.
4. Review any non-zero malformed or failed count before manual intervention.

Do not deploy code that writes the new claim fields before the migration.
