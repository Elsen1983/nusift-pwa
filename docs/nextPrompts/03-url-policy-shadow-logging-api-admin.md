# Prompt 03 - URL Policy Shadow Logging, API, And Admin Report

You are working in the NuSift repository.

Goal:
Wire the versioned URL policy evaluation framework into read-only/shadow diagnostics and expose a safe admin/API report.

This prompt assumes Prompt 01 and Prompt 02 are complete:
- dataset schema exists
- production and candidate evaluators exist
- evaluation runner and metrics exist

This prompt covers:
- optional decision logging using existing artifact patterns where possible
- baseline-vs-candidate read-only API
- compact admin display if feasible
- minimal Agent 1 / Agent 2 observation integration

This prompt must not change production filtering behavior.

Strictly out of scope:
- PUBLISHABLE status
- ArticleCandidate refactor
- Source Registry
- event clustering
- ranking
- fact-checking
- review queue
- new infrastructure
- automatic promotion of SHADOW rules to ENFORCED

Required work:

1. Decision logging model

Implement a lightweight way to log URL policy decisions using existing project patterns.

Prefer PipelineArtifact payloads or existing diagnostic artifact infrastructure.
Do NOT add a Prisma migration unless absolutely necessary and justified.

A decision log must preserve:
- url
- normalizedUrl
- sourceId/categoryId when available
- agent
- stage
- discoveryMethod when available
- policyVersion
- ruleVersion when available
- enforcementMode: ENFORCED or SHADOW
- decision: ACCEPT, REJECT, or UNCERTAIN
- reasonCode
- compact evidence
- evaluationDatasetVersion when relevant
- createdAt

Evidence must be small and structured.
Never store:
- full HTML
- large DOM snippets
- full article body text
- sensitive query strings when avoidable

Normalize or strip sensitive query parameters before decision logging.

2. Production baseline and candidate policy must both be observable

For a discovered URL, support logging both:

A. current production decision
- enforcementMode: ENFORCED
- current production policy version

B. candidate shadow decision
- enforcementMode: SHADOW
- candidate policy version

Important:
If production policy would hard reject, candidate shadow evaluation should still run whenever practical, so both decisions are available for comparison.

Only the production decision may affect existing behavior.
A SHADOW REJECT must never block the URL.

3. Minimal Agent 1 / Agent 2 integration

Wire decision observation into Agent 1 and Agent 2 at the smallest safe points.

Agent 1:
- observe RSS/feed item URL policy decisions near canonical URL resolution
- log both production and candidate decisions
- preserve existing enforced behavior exactly

Agent 2:
- observe static/listing/sitemap candidate URL policy decisions
- log both production and candidate decisions where practical
- preserve existing enforced behavior exactly

Do not do large refactors.
Do not weaken existing hard rejects.

Avoid duplicate decision logs during retries or nested policy calls.
If necessary, create an idempotency key from:
- normalized URL
- agent
- stage
- policyVersion
- enforcementMode
- pipelineRunId or batch run id when available

4. Read-only API endpoint

Add a dev/admin protected API endpoint or extend an existing dev/admin diagnostics endpoint to expose:
- latest evaluation report
- metrics by split: tuning and holdout
- metrics by policy version
- production baseline vs candidate comparison
- counts by expectedType
- counts by expectedAcceptanceClass
- counts by decision
- false reject samples
- non-article leakage samples
- uncertain samples
- optionally recent logged production/shadow decisions

The endpoint must:
- require existing dev/admin access controls
- be read-only
- not mutate Article records
- not expose sensitive query parameters
- use bounded result sizes

5. Admin UI

If feasible, add a compact admin section:

URL Policy Evaluation
- dataset version
- tuning metrics
- holdout metrics
- production baseline vs candidate delta
- false reject samples
- non-article leakage samples
- uncertain samples

If full UI is too large, implement the API and document how to inspect JSON output.

Do not clutter existing Agent 1/2/3 panels. Keep this as a compact diagnostic section.

6. Tests

Add tests proving:
- ENFORCED and SHADOW decisions can be logged for the same URL
- SHADOW REJECT does not block the URL
- production behavior remains unchanged
- decision payload preserves policyVersion, enforcementMode, reasonCode, and evidence
- evidence is bounded/sanitized
- API endpoint is admin/dev protected
- API endpoint is read-only
- API returns tuning and holdout separately
- API returns production and candidate metrics separately
- duplicate decision logs are avoided or bounded if idempotency is implemented

Validation:
- Run npx nuxt typecheck.
- Run targeted tests for new logging/API/admin utilities.
- Run relevant Agent 1/Agent 2 tests if touched.

Acceptance criteria:
- Production and candidate decisions can be observed for the same URL.
- Candidate SHADOW decisions never affect production behavior.
- Admin/API report exposes baseline-vs-candidate comparison.
- Logged evidence is compact and safe.
- Existing hard reject behavior remains unchanged.
- No Prisma migration unless explicitly justified.
