# Prompt 17I - Shadow Rollout and Final Validation Report

Date: 2026-08-10

## Executive Conclusion

**READY FOR SHADOW, NOT READY FOR PRODUCTION ENFORCEMENT.**

The implementation is safe to exercise with the domain governor in `off` or
`shadow` mode after the migration and deployment prerequisites are satisfied.
Production enforcement must remain disabled until migration history and
deployment state are independently verified. No production database, API,
Vercel environment, publisher, migration deployment, commit, or push was
accessed during this validation.

## Findings

### P1 - Operational migration gate remains unverified

The Domain Governor and Publisher Robots Policy migrations are present in this
checkout, but production/staging deployment history and immutable checksums
cannot be proven from the current dirty worktree. They are now applied to the
local `localhost:5432/nusift_sanitized` database and its Prisma status is up to
date. Do not enable `enforce` in any shared environment until that environment
independently reports both migrations as applied and the expected tables/indexes
are confirmed through a non-PII deployment check.

### P1 - Redirect-target robots bypass was fixed

Before this validation, the governed request checked robots policy for the
initial URL but not for redirect targets. A publisher redirect could therefore
reach the SSRF transport without the shared robots decision. The governed
transport now checks every non-initial redirect target before its transport in
`server/utils/news-pipeline/governed-fetch.ts`, while preserving the single
initial check and the logical request-budget semantics. Regression coverage is
in `server/utils/news-pipeline/governed-fetch.test.ts`.

### P2 - Shared-environment PostgreSQL concurrency is unverified

The real Domain Governor concurrency integration now passes against the local
PostgreSQL database using randomized isolated schemas. Shared-environment
concurrency remains unverified, and no separate real-PostgreSQL robots-cache
concurrency suite exists in this checkout. Unit tests and controlled
fake-database contracts cover the robots cache behavior.

### P2 - Live browser and publisher validation is unverified

No live Chromium publisher request, Vercel runtime, or authenticated end-to-end
Agent 1 -> Agent 2 -> Agent 3 run was performed. Browser lifecycle, redirect,
robots, cooldown, and claim behavior are covered by mocks and orchestration
tests only.

### P2 - Historical per-request governance evidence is bounded

The current observability layer can honestly report available bounded state and
mark unavailable fields rather than fabricating request history. It does not
retroactively provide a complete per-request domain/purpose/circuit timeline
for older artifacts.

## Verification Matrix

| Area | Verified behavior | Evidence and limitation |
| --- | --- | --- |
| 17A | Static 429 is no-browser, same-host stop, and persistence-aware | Focused Agent 2/3 tests; live browser not run |
| 17B | Domain Governor normalization, leases, CAS, shadow isolation, and bounded recovery | Unit tests plus local PostgreSQL concurrency; shared-environment deployment unverified |
| 17C | Governed parser-aware static lifecycle, redirect-hop leases, budget accounting, and typed defers | Focused governed-fetch and pipeline tests; real transport not run |
| 17D | Browser navigation governance and no navigation after policy denial | Browser/navigation mock tests; live Chromium not run |
| 17E | Invocation-scoped Agent 3 browser reuse, context isolation, cleanup, and time budgets | Session and queue tests; live browser not run |
| 17F | Centralized feed-first eligibility, source/category scope, stale recovery, and neutral skips | Feed-first policy tests; no live feed registration or pipeline run |
| 17G | Shared robots parsing, bounded cache policy, unavailable-status matrix, and no browser robots fallback | Robots policy tests; real PostgreSQL cache concurrency skipped |
| 17H | Read-only admin diagnostics, authorization, redaction, cursor pagination, and honest unavailable evidence | 7 focused tests passed; no production admin endpoint access |
| Redirect correction | Robots policy is checked before the initial request and every redirect target | `governed-fetch` regression test passed |

## Exact Policy Boundaries

### Governor modes

- `off`: no durable governor coordination; existing SSRF and robots policy
  boundaries still apply.
- `shadow`: record bounded would-defer diagnostics without suppressing the
  request or mutating coordination state.
- `enforce`: acquire and complete durable domain leases; deny/defer according
  to the persisted circuit state.

The default remains `off` when no mode is configured. Shadow evidence must not
be counted as an actual defer, publisher failure, hard-source failure, browser
failure, or successful recovery.

### Request order

For each static publisher request, the relevant flow is:

1. Validate the URL and SSRF target.
2. Check the robots policy for the current URL.
3. Acquire or evaluate the Domain Governor decision.
4. Consume the Agent-local logical request budget only for an allowed request.
5. Perform the transport and hold the final permit through body parsing.
6. Record the authoritative response outcome once.
7. Release only an unfinished lease.
8. Apply persistence-aware stage and artifact semantics.

For a redirect, steps 1-7 are repeated per target domain. The robots check is
performed before each redirect target transport, and each redirect domain has
its own governor decision. A static HTTP 429 remains a no-browser boundary;
HTTP 403 and HTTP 200 interstitial/challenge results retain their existing
bounded browser-fallback rules where applicable.

## Shadow Readiness Gates

Before enabling shadow in a deployment environment, verify all of the
following:

- [ ] Backup and rollback readiness are documented.
- [ ] The intended database target is confirmed without printing credentials.
- [ ] The 17B and 17G forward migrations are present in the deployment artifact.
- [ ] Migration status and table/index metadata are checked in the intended
  environment.
- [ ] Application mode is explicitly `shadow` or remains `off`; it is not
  silently promoted to `enforce`.
- [ ] A team-defined sample of complete scheduled runs is observed.
- [ ] Admin diagnostics show bounded decisions, redaction, pagination, and
  unavailable evidence honestly.
- [ ] Feed-first skips, robots denials, 429 cooldowns, browser fallback
  boundaries, and persistence-aware counters are inspected.
- [ ] No shadow-would-defer event is treated as an actual defer or failure.
- [ ] A rollback is prepared as an environment-mode change to `off` or
  `shadow`; no destructive schema rollback is used.

## Deployment Order

This is an operational runbook only. It was not executed here.

1. Confirm backup and rollback readiness.
2. Confirm the production `DATABASE_URL` target without exposing its value.
3. Run `npx prisma migrate deploy` against that intended database.
4. Run `npx prisma migrate status` and confirm the Domain Governor and
   Publisher Robots Policy migrations are applied.
5. Confirm the `DomainRequestGovernor` and `PublisherRobotsPolicy` tables and
   their expected unique/index constraints using non-PII metadata inspection.
6. Deploy the application with governor mode `shadow` or `off`.
7. Run the controlled, team-approved shadow observation sample.
8. Inspect the read-only admin diagnostics and compare actual work with
   durable outcomes.
9. Only after the enforce gates pass, enable `enforce` through the approved
   environment/configuration rollout mechanism. If staged rollout is not
   supported, keep `enforce` disabled.
10. If anomalies appear, set the mode back to `shadow` or `off` and preserve
    the evidence for investigation.

The migration must precede application code that reads or writes the durable
governor or robots-cache models. Application rollback is an environment/config
operation; migration rollback is not a destructive production reset.

## Validation Results

- Full Vitest: **144 test files passed, 5 skipped; 3001 tests passed, 6
  skipped**.
- Focused Prompt 17 matrix: **20 files, 779 passed, 1 skipped**.
- Agent 1 ingest integration after test isolation correction: **37/37 passed**.
- Governed-fetch redirect regression suite: **12/12 passed**.
- Robots policy and Domain Governor unit suites: **35/35 passed**.
- Local Domain Governor PostgreSQL concurrency integration: **1/1 passed**.
- Local Chromium headless smoke: **passed**; publisher navigation was not run.
- `npx prisma validate`: passed.
- `npx prisma generate`: passed, also executed by the production build.
- `npx nuxt typecheck`: passed.
- Workflow bundle guard: passed; 2675 generated JavaScript/JSON files
  inspected.
- Production build: passed.
- `git diff --check`: exit code 0.

The Windows `taskkill.exe` cleanup warning, existing sourcemap/deprecation
warnings, and npm update notice are environmental/non-blocking warnings. The
remaining opt-in PostgreSQL suites were not reported as passed.

## Local Follow-up Execution

The following local-only steps were completed after the initial report:

1. `npx prisma migrate deploy` applied
   `20260811000000_add_publisher_robots_policy` to
   `localhost:5432/nusift_sanitized`.
2. `npx prisma migrate status` reported `Database schema is up to date!`.
3. The opt-in Domain Governor PostgreSQL integration ran with the local
   `.env` target and passed **1/1**, using independent pools and randomized
   temporary schemas.
4. The robots policy and Domain Governor unit suites passed **35/35**.
5. `playwright-core` launched a local headless Chromium page successfully;
   no publisher URL or production environment was contacted.

No shadow database, production database, publisher, Vercel environment, or
remote API was contacted by these local follow-up steps.

## Scope and Residual Risk

The only source correction made during this audit was the redirect-target
robots check and its regression coverage. The Agent 1 integration test double
was updated to mock the already-shared robots policy so its assertions remain
about ingest behavior rather than re-testing the robots module.

No publisher-specific URL exception, anti-bot bypass, proxy, stealth behavior,
scrolling, CAPTCHA handling, schema reset, production feed registration, or
public diagnostic endpoint was added. The remaining risk is operational and
environmental: shared-environment lease contention, live browser runtime
behavior, deployment migration history, and end-to-end publisher behavior
still require staging or production-approved verification.

**Final status: READY FOR SHADOW; NOT READY FOR PRODUCTION ENFORCEMENT.**
