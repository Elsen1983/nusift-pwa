# Prompt 17I - Shadow Rollout and Final Validation

## Objective

Complete a conservative shadow-to-enforcement readiness audit for Prompt 17A-17H while keeping production deployment and production database actions separately authorized.

This prompt may correct verified integration defects and documentation gaps. It must not silently enable production enforcement or run production operations.

## Preconditions

Confirm that:

- Prompt 17A-17H are implemented in order;
- all forward migrations are present and immutable;
- Prompt 16 structured access classification remains canonical;
- the default governor mode is `off` or `shadow`;
- no cross-invocation browser state exists;
- repository status and unrelated changes are understood before editing.

## Final code audit

Trace all of these end to end:

1. Agent 1 feed request -> governor -> SSRF-safe fetch -> candidate persistence -> telemetry.
2. Agent 2 listing/robots/sitemap/detail -> local budget -> governor -> fetch -> partial persistence -> marker CAS.
3. Agent 2 headless main navigation -> governor -> browser result -> marker state -> hard-source side effects.
4. Agent 3 static extraction -> 429 no-browser invariant -> retry/cooldown persistence.
5. Agent 3 browser fallback -> governor -> invocation-scoped session -> access classifier -> claim/CAS persistence.
6. Feed-first target skip -> no network -> no marker -> neutral diagnostics.
7. Robots denial -> no network/browser -> neutral diagnostics.
8. Governor lease expiry, stale token, DB failure, and half-open recovery.
9. Public feed, notification, reader, card, dashboard, and admin behavior after Prompt 16.

Audit every observable success channel: Article state, PipelineArtifact state, logs, counters, hard-source profiles, admin summaries, feed/publication, and notification counts.

## Shadow-mode verification

Add or maintain a safe shadow report that shows:

- total governed opportunities;
- allowed decisions;
- shadow-would-defer decisions by reason;
- 429 circuits that would open;
- lease-contention decisions;
- feed-first and robots skips;
- request counts by stage/purpose/transport;
- browser amplification counts;
- malformed/missing evidence;
- bounded per-domain summaries.

Shadow mode must not suppress requests or change durable article/marker/publication decisions.

## Enforcement readiness gates

Document measurable gates before production enforce mode may be enabled:

- no browser launch after static 429;
- no duplicate same-domain enforce leases in PostgreSQL concurrency tests;
- zero stale-token state overwrites;
- zero ungoverned publisher main navigations;
- zero false success from governor denial or persistence conflict;
- bounded and secret-free telemetry;
- no regression in Agent 1/2/3 persisted counters;
- full suite/typecheck/build/workflow bundle pass;
- required migrations deployed before enforce-capable application code;
- rollback procedure tested in a non-production environment.

Do not invent a universal numeric defer threshold. Derive proposed policy thresholds from observed shadow data and document confidence/sample size.

## Required test layers

1. Unit tests for pure policies and serialization.
2. Mock orchestration tests for Agent 1/2/3 failure paths.
3. Opt-in localhost PostgreSQL tests with two independent clients for leases/CAS/circuit transitions.
4. Local browser-runtime test for one-browser/one-page bounds when available.
5. One local end-to-end pipeline fixture covering Agent 1 -> Agent 2 -> Agent 3 without live publisher dependency.
6. Public feed/notification/admin contract regressions.

Classify each layer accurately as passed, skipped, blocked, or unverified.

## Deployment documentation

Write the exact safe order without executing it:

1. Confirm backup and rollback readiness.
2. Verify the intended production database target without printing credentials.
3. Run `npx prisma migrate deploy` against the authorized production target.
4. Verify migration status and required governor/robots columns/indexes using non-PII metadata.
5. Deploy application code with governor mode `shadow`.
6. Observe at least the agreed number of complete pipeline runs.
7. Review shadow metrics and publisher behavior.
8. Enable enforcement for a small allowlisted domain set or controlled percentage if the implementation supports it.
9. Verify cooldown, half-open, feed-first, browser, persistence, and admin evidence.
10. Expand gradually or return to shadow immediately if gates fail.

Feature-flag rollback must require no schema rollback and no destructive data change.

## Validation

Run:

```text
npx prisma validate
npx prisma generate
npx vitest run <all focused Prompt 17 suites>
npm test
npx nuxt typecheck
npm run verify:workflow-bundle
npm run build
git diff --check
```

Run opt-in PostgreSQL/browser tests only under their explicit local safety gates. Never weaken localhost-only guards to make a test pass.

## Acceptance criteria

- No unresolved P0/P1 correctness finding remains.
- Every Prompt 17 behavior is linked to source and regression tests.
- Migrations and deployment order are explicit.
- Default production behavior remains shadow/off until separately authorized.
- The report distinguishes implementation, unit/mock verification, PostgreSQL verification, browser verification, migration deployment, application deployment, and production smoke testing.

## Safety

- Do not access production DB/API/Vercel/secrets.
- Do not deploy migrations or application code.
- Do not enable production enforcement.
- Do not run live publisher load tests.
- Do not commit or push.

## Completion response

Provide findings first by severity with exact file/line references. Then provide the implementation/verification matrix, migration/deployment status, residual risks, and a clear `READY FOR SHADOW`, `NOT READY`, or `BLOCKED` conclusion.
