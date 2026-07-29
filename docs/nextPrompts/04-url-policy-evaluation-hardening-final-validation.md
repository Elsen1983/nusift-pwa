# Prompt 04 - URL Policy Evaluation Hardening And Final Validation

You are working in the NuSift repository.

Goal:
Perform the hardening pass and final validation for the Versioned URL Policy Evaluation Framework with Shadow Decisions and Baseline Comparison.

This prompt assumes Prompts 01-03 are complete.

This prompt covers:
- risk controls
- regression tests
- documentation
- final validation

Do not add new product scope.
Do not implement production gating, PUBLISHABLE status, ArticleCandidate refactor, Source Registry, event clustering, ranking, fact-checking, review queue, or new infrastructure.

Required checks and fixes:

1. Production behavior preservation

Verify that existing production URL filtering behavior is unchanged.

Specifically:
- existing hard rejects still reject
- existing accepted URLs still accept
- isLikelyArticleUrl() behavior is unchanged unless explicitly intended and tested
- SHADOW decisions never block URLs
- evaluation runner has no side effects

Add regression tests if any of these are not already covered.

2. Early return safety

Review Agent 1 and Agent 2 URL policy integration points.

Ensure candidate shadow policy evaluation is not skipped just because production policy would hard reject, wherever practical.

If there are unavoidable cases where shadow evaluation cannot run, document them in code comments and in the final summary.

3. Duplicate decision logging

Check for duplicate decision logs caused by:
- retries
- nested policy calls
- both listing and detail evaluation
- sitemap and metadata evaluation overlap

If duplicate risk exists, add an idempotency key or bounded dedupe logic.

Do not introduce large infrastructure.

4. Evidence safety

Verify decision evidence:
- does not include full HTML
- does not include article body text
- does not include large DOM snippets
- strips or normalizes sensitive query parameters where possible
- is size-bounded

Add tests for evidence bounding/sanitization.

5. Deterministic report hardening

Verify evaluation report output:
- stable policy ordering
- stable split ordering
- stable sample ordering by URL or deterministic key
- stable object shape
- fixed precision rates
- raw counts beside rates
- no wall-clock duration in snapshot-compared output

Add snapshot or structural tests if useful.

6. Metric semantics

Reconfirm formulas:

article_accept_precision =
  accepted true articles / all accepted URLs

article_accept_recall =
  accepted true articles / all true articles

false_reject_rate =
  rejected true articles / all true articles

non_article_leakage_rate =
  accepted non-article URLs / all accepted URLs

uncertain_rate =
  UNCERTAIN decisions / all evaluated URLs

policy_coverage =
  ACCEPT or REJECT decisions / all evaluated URLs

uncertain_article_rate =
  uncertain true articles / all true articles

uncertain_non_article_rate =
  uncertain non-articles / all non-articles

If implementation differs, fix it.

7. Holdout integrity

Verify:
- tuning and holdout are reported separately
- no code automatically tunes thresholds from holdout
- holdout is not used to mutate candidate policy config
- report clearly identifies datasetVersion and split

8. Admin/API protection

Verify:
- endpoint is dev/admin protected using existing repo patterns
- endpoint is read-only
- endpoint has bounded output
- endpoint does not expose sensitive query params
- endpoint does not write Article records or trigger pipeline work

9. Documentation

Add or update documentation with:
- purpose of URL policy evaluation framework
- how tuning and holdout differ
- how ENFORCED and SHADOW differ
- exact metric definitions
- how to run the evaluation runner
- how to inspect the admin/API report
- clear note that this ticket does not change production gating
- next decision process: analyze baseline vs candidate report before promoting rules

Keep documentation concise and practical.

10. Validation

Run:
- npx nuxt typecheck
- targeted tests for all new evaluation utilities
- existing article-url-policy tests
- touched Agent 1 / Agent 2 tests
- touched API/admin tests

Run the full test suite if feasible.

If one or more failures are pre-existing, prove that with targeted evidence or clearly state it was not verified.

Final report must include:
- files changed
- behavior changed: should be measurement-only
- tests run
- whether production behavior changed
- whether Prisma schema changed
- remaining known gaps
- next decision point: analyze first baseline-vs-candidate evaluation report

Acceptance criteria:
- Production behavior is unchanged.
- SHADOW decisions do not block.
- Evaluation report is deterministic.
- Metrics match definitions.
- Admin/API is protected and read-only.
- Evidence is compact and safe.
- Tuning and holdout remain separate.
- No scope creep features were added.
