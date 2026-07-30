# URL Policy Evaluation Framework

**Last reviewed from code:** 2026-07-30

## Purpose

The URL Policy Evaluation Framework provides a versioned, measurable approach to evaluating and comparing URL acceptance policies used by Agent 1 (RSS ingest) and Agent 2 (static discovery). It answers the question: *is our current URL filtering policy correctly accepting article URLs and rejecting non-article URLs?*

The framework does **not** change production gating behavior. It is measurement-only infrastructure that supports data-driven decisions about future policy changes.

## Key Concepts

### ENFORCED vs SHADOW

| Mode | Description | Blocks URLs? |
|------|-------------|--------------|
| **ENFORCED** | The current production policy. Decisions are acted upon — rejected URLs are dropped from the pipeline. | Yes |
| **SHADOW** | A candidate policy evaluated alongside production. Decisions are recorded but **never** acted upon. Used to measure how a proposed policy would perform without changing production behavior. | No |

Both modes are evaluated side-by-side for every URL. The comparison report shows how the candidate policy diverges from production.

### Tuning vs Holdout

| Split | Purpose | Used for threshold adjustment? |
|-------|---------|-------------------------------|
| **tuning** | Small stratified dataset used to calibrate and iterate on candidate policies. | Yes |
| **holdout** | Small stratified dataset held back for final validation only. | **No** — never used to mutate candidate policy config |

Both splits are reported separately in the evaluation report. This prevents overfitting: a candidate policy that looks good on tuning but degrades on holdout has likely overfit to the tuning set.

## Metric Definitions

All metrics are computed per-split, per-policy. Formulas:

| Metric | Formula | Description |
|--------|---------|-------------|
| `articleAcceptPrecision` | accepted true articles / all accepted URLs | How many accepted URLs are actually articles |
| `articleAcceptRecall` | accepted true articles / all true articles | How many true articles the policy accepts |
| `falseRejectRate` | rejected true articles / all true articles | How many true articles the policy incorrectly rejects |
| `nonArticleLeakageRate` | accepted non-article URLs / all accepted URLs | How many accepted URLs are actually non-articles |
| `uncertainRate` | UNCERTAIN decisions / all evaluated URLs | Proportion of URLs the candidate policy is unsure about |
| `policyCoverage` | (ACCEPT + REJECT) / all evaluated URLs | Proportion of URLs with a definitive decision |
| `uncertainArticleRate` | uncertain true articles / all true articles | Proportion of true articles the candidate is unsure about |
| `uncertainNonArticleRate` | uncertain non-articles / all non-articles | Proportion of non-articles the candidate is unsure about |

**Note:** `uncertainRate`, `uncertainArticleRate`, and `uncertainNonArticleRate` are always 0 for the production policy (which never returns UNCERTAIN). They are only meaningful for the candidate policy.

## Architecture

### Core Files

| File | Purpose |
|------|---------|
| `server/utils/news-pipeline/url-policy-evaluation.ts` | Dataset schema, policy evaluators, evidence sanitization |
| `server/utils/news-pipeline/url-policy-evaluation-runner.ts` | Deterministic evaluation runner and metric computation |
| `server/utils/news-pipeline/url-policy-decision-observer.ts` | Live observation and persistence of policy decisions |
| `server/api/dev/url-policy-evaluation.get.ts` | Admin API endpoint for evaluation reports |
| `server/utils/news-pipeline/article-url-policy.ts` | The shared production URL classification policy |

### How the Evaluators Work

- **`evaluateProductionUrlPolicy(input)`** — Delegates to `classifyArticleUrl()`. Returns ACCEPT or REJECT (never UNCERTAIN). ENFORCED mode.
- **`evaluateCandidateUrlPolicy(input)`** — Also delegates to `classifyArticleUrl()` but adds a UNCERTAIN path for URLs where production accepted but signals are weak (borderline acceptance). SHADOW mode.
- Both evaluators are **side-effect-free**: no I/O, no mutations, no external calls. They produce the same output for the same input every time.

### Evidence Safety

Decision evidence is bounded and sanitized:

- **No full HTML, body text, or DOM fragments** — the `sanitizeEvidence()` function strips unsafe keys (`html`, `body`, `dom`, `pageText`, `fullText`, `content`, `rawHtml`)
- **Signal count bounded** — the `signals` array is capped at 20 entries
- **Total JSON size bounded** — evidence exceeding 2048 bytes is replaced with a compact fallback
- **Sensitive query parameters stripped** — URLs are sanitized before persistence via `sanitizeUrlForLogging()`

## How to Run the Evaluation Runner

### Via Admin API (recommended)

```
GET /api/dev/url-policy-evaluation
```

Requires admin authentication. Returns a JSON report with:

- `datasetVersion` — identifies the evaluation dataset version
- `splits` — per-split (tuning, holdout) metrics for both production and candidate policies
- `comparison` — delta metrics between production and candidate for each split
- Optional: `?recentDecisions=true` includes recently persisted live observations

### Programmatic (tests/scripts)

```typescript
import { createTuningDataset, createHoldoutDataset } from "./url-policy-evaluation";
import { runUrlPolicyEvaluation } from "./url-policy-evaluation-runner";

const report = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
// report.splits.tuning.policies["current-production-v1"].rates
// report.splits.tuning.policies["candidate-v1"].rates
// report.comparison
```

## Online Decision Persistence Safety

Per-URL decision persistence is disabled by default. Agent 1 and Agent 2 still
evaluate production and candidate decisions, but they do not create observation
PipelineRun and PipelineArtifact rows unless
`NUXT_ENABLE_URL_POLICY_DECISION_PERSISTENCE=true`.

Do not enable this flag in production until persistence is converted to a
bounded, request-scoped batch writer that reuses the active pipeline run.
The static tuning/holdout evaluation report does not depend on this flag.

## How to Inspect the Admin Report

The admin UI at `/admin` includes a "URL Policy Evaluation" panel (visible when dev tools are enabled). It shows:

1. **Dataset version and policy names** at the top
2. **Per-split, per-policy metrics** — evaluated/accepted/rejected/uncertain counts plus all 8 rate metrics
3. **Production vs candidate delta** — comparison entries showing how each metric differs between policies
4. **Sample groups** — up to 5 samples each for false rejects, leakage, and uncertain decisions

## What This Framework Does NOT Change

- **Production gating** — SHADOW decisions never block URLs. The production URL policy behavior is unchanged.
- **Article lifecycle** — no `ArticleCandidate` table, no `PUBLISHABLE` status, no lifecycle refactor
- **Source Registry** — no new infrastructure
- **Prisma schema** — uses existing `PipelineArtifact` model, no migration required

## Next Decision Point

The first baseline-vs-candidate evaluation report should be analyzed before promoting any new rules. Specifically:

1. Review the tuning split comparison to understand where the candidate policy diverges from production
2. Check the holdout split to verify the candidate doesn't overfit
3. Examine false reject samples to ensure the candidate doesn't reject valid articles
4. Examine leakage samples to understand what non-articles production currently accepts
5. Only promote future candidate rules from SHADOW to ENFORCED after holdout results are reviewed and approved

## Duplicate Decision Logging

Observation calls at different pipeline stages (listing extraction, metadata evaluation, RSS ingest) produce separate decision logs with distinct idempotency keys. This is intentional — each stage captures a different decision context. The existing `buildDecisionLogIdempotencyKey()` function prevents duplicates from retries within the same stage.

## Known Gaps

1. **Small initial datasets** — The tuning dataset has ~25 URLs and holdout has ~10 URLs. These should be expanded to 300-500+ labeled URLs for statistically meaningful metrics. The schema supports this growth.

2. **Candidate policy is currently a clone** — The candidate policy starts as a copy of production with only a UNCERTAIN path added. Future work should add genuinely different candidate rules and measure their impact via the shadow framework.
