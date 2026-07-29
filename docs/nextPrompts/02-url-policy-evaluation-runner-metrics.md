# Prompt 02 - URL Policy Evaluation Runner And Metrics

You are working in the NuSift repository.

Goal:
Build the deterministic evaluation runner and metric calculations for the versioned URL Policy Evaluation Framework.

This prompt assumes Prompt 01 is complete:
- evaluation dataset schema exists
- tuning and holdout fixtures exist
- expectedAcceptanceClass exists
- production and candidate URL policy evaluators exist
- decisions use ENFORCED / SHADOW and ACCEPT / REJECT / UNCERTAIN

This prompt covers only:
- deterministic evaluation runner
- metric calculations
- baseline-vs-candidate comparison output
- tests

Do not change production filtering behavior.
Do not add PUBLISHABLE status, ArticleCandidate refactor, Source Registry, event clustering, ranking, fact-checking, review queue, or new infrastructure.

Required work:

1. Evaluation runner

Create a utility that:
- loads tuning and holdout datasets
- runs the production baseline policy and candidate shadow policy on every URL
- computes metrics separately for each split and each policy version
- produces deterministic JSON output

The runner must evaluate the same URL with:

A. production baseline
- enforcementMode: "ENFORCED"
- policyVersion: current production version

B. candidate policy
- enforcementMode: "SHADOW"
- policyVersion: candidate version

The runner must not:
- write artifacts
- update counters
- mutate Article records
- trigger Agent workflows
- persist decision logs unless explicitly invoked in a separate logging mode

2. Metrics

Implement these metric definitions exactly.

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

Also include:
- uncertain_article_rate
- uncertain_non_article_rate

Use expectedAcceptanceClass as the source of truth:
- ACCEPTABLE_ARTICLE means true article
- NON_ARTICLE means non-article

UNCERTAIN handling:
- must not count as an automatic false decision
- must lower policy_coverage
- must be reported separately
- must be included in uncertain_article_rate or uncertain_non_article_rate depending on expectedAcceptanceClass

3. Separate URL classification and extraction metrics

Do not combine URL classification metrics with extraction success metrics.

If extractionExpected is present in the dataset, report it in a separate section only:
- extractionExpectedCount
- extractionNotExpectedCount
- extractionExpectationCoverage

Do not use extractionExpected to alter URL policy precision/recall.

4. Deterministic JSON output

The evaluation report output must be deterministic:
- stable policy ordering
- stable split ordering
- stable sample ordering, preferably by URL
- stable object key structure for snapshot tests
- no wall-clock duration in snapshot-compared output
- rates rounded to fixed precision, for example 6 decimal places
- raw counts always included next to rates

Example shape:

{
  "datasetVersion": "url-eval-2026-08-v1",
  "splits": {
    "tuning": {
      "policies": {
        "current-production-v1": {
          "counts": {
            "evaluated": 100,
            "accepted": 70,
            "rejected": 20,
            "uncertain": 10
          },
          "rates": {
            "articleAcceptPrecision": 0.942857
          }
        }
      }
    }
  }
}

5. Samples

Include compact sample groups:
- falseRejectSamples
- nonArticleLeakageSamples
- uncertainSamples

Samples must be sorted deterministically, preferably by URL.

Keep sample evidence small. Do not include full HTML, full page text, or large DOM fragments.

6. Baseline comparison

Add comparison output between production baseline and candidate policy:
- split
- metric name
- production value
- candidate value
- delta

Do not interpret the result as pass/fail yet. This ticket only reports measurements.

7. Tests

Add tests for:
- precision calculation
- recall calculation
- false_reject_rate calculation
- non_article_leakage_rate denominator is all accepted URLs
- uncertain_rate calculation
- policy_coverage calculation
- uncertain article/non-article rates
- tuning and holdout reported separately
- production and candidate policies reported separately
- deterministic output ordering
- rates rounded to fixed precision
- raw counts preserved next to rates
- extraction metrics separated from URL classification metrics
- false reject, leakage, and uncertain samples are deterministic

Validation:
- Run npx nuxt typecheck.
- Run targeted tests for evaluation utilities.
- Run existing article-url-policy tests.

Acceptance criteria:
- Evaluation runner produces deterministic JSON.
- Metrics match formulas exactly.
- Tuning and holdout are separate.
- Production baseline and candidate policy are compared.
- UNCERTAIN is handled correctly.
- No production behavior changes.
- No Prisma schema migration.
