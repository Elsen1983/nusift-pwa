# Prompt 01 - URL Policy Evaluation Foundation

You are working in the NuSift repository.

Goal:
Implement the foundation for a versioned URL Policy Evaluation Framework. This is the first part of the larger ticket:

Versioned URL Policy Evaluation Framework with Shadow Decisions and Baseline Comparison

This prompt covers only:
- evaluation dataset schema
- tuning and holdout fixtures
- centralized expectedAcceptanceClass
- versioned URL policy decision types
- side-effect-free production and candidate policy evaluator interfaces

Do not implement production gating, PUBLISHABLE status, ArticleCandidate refactor, Source Registry, event clustering, ranking, fact-checking, review queue, or new infrastructure.

Current context:
NuSift already has Agent 1 RSS ingest, Agent 2 static/browser discovery, Agent 3 enrichment, rejection diagnostics, pipeline artifacts, source health, retry/cooldown logic, and a shared article URL policy.

Production behavior must remain unchanged.

Required work:

1. Create evaluation dataset schema

Add a small, versioned evaluation dataset structure for URL classification.

Use a TypeScript shape equivalent to:

type UrlEvaluationLabel = {
  url: string;
  sourceId?: string;
  categoryId?: string;
  discoveryMethod?:
    | "RSS"
    | "ATOM"
    | "JSON_FEED"
    | "HTML_FALLBACK"
    | "STATIC_LISTING"
    | "SITEMAP"
    | "BROWSER"
    | "MANUAL";
  expectedType:
    | "ARTICLE"
    | "LISTING"
    | "HOMEPAGE"
    | "MEDIA"
    | "LIVEBLOG"
    | "GALLERY"
    | "PAYWALL_ARTICLE"
    | "STALE_ARTICLE"
    | "BAD_CANONICAL"
    | "OTHER";
  expectedAcceptanceClass:
    | "ACCEPTABLE_ARTICLE"
    | "NON_ARTICLE";
  shouldAccept: boolean;
  extractionExpected?: boolean;
  expectedCanonicalUrl?: string;
  expectedPublishedDate?: string;
  expectedLanguage?: string;
  notes?: string;
  labelVersion: number;
  labelledAt: string;
  labelledBy: string;
};

Dataset metadata must include:
- datasetVersion, for example "url-eval-2026-08-v1"
- split: "tuning" | "holdout"

Create small initial fixtures for both tuning and holdout. They do not need 300-500 URLs yet, but the format must support that later.

Use stratified examples:
- normal article URLs
- listing/category/topic pages
- homepage
- media/video/podcast/radio clip URLs
- liveblog
- gallery
- paywall article
- stale article
- bad canonical style case
- RSS/static/browser/manual origins when practical

2. Central expectedAcceptanceClass mapping

Do not infer "true article" semantics from expectedType in multiple places.

If deriving expectedAcceptanceClass from expectedType, define exactly one versioned helper.

Recommended default mapping:

ACCEPTABLE_ARTICLE_TYPES = new Set([
  "ARTICLE",
  "LIVEBLOG",
  "PAYWALL_ARTICLE",
  "STALE_ARTICLE",
]);

Treat GALLERY, MEDIA, BAD_CANONICAL, LISTING, HOMEPAGE, OTHER as NON_ARTICLE unless explicitly overridden by expectedAcceptanceClass.

Metrics later must use expectedAcceptanceClass as the source of truth.

3. Versioned URL policy decision type

Introduce a shared decision type equivalent to:

type UrlPolicyDecisionLog = {
  id?: string;
  url: string;
  normalizedUrl?: string;
  sourceId?: string | null;
  categoryId?: string | null;

  agent: "AGENT_1" | "AGENT_2" | "AGENT_3";
  stage: string;
  discoveryMethod?: string | null;

  policyVersion: string;
  ruleVersion?: string | null;
  enforcementMode: "ENFORCED" | "SHADOW";

  decision: "ACCEPT" | "REJECT" | "UNCERTAIN";
  reasonCode: string;
  evidence?: Record<string, unknown>;

  evaluationDatasetVersion?: string | null;
  createdAt: string;
};

Keep evidence small and structured. Never store full HTML or large DOM fragments.

4. Side-effect-free policy evaluators

Add side-effect-free evaluator interfaces:

evaluateProductionUrlPolicy(input): UrlPolicyDecisionLog
evaluateCandidateUrlPolicy(input): UrlPolicyDecisionLog

The production evaluator must represent what the current system actually does.

The candidate evaluator must support three states:
- ACCEPT
- REJECT
- UNCERTAIN

Existing behavior must remain unchanged. Existing boolean helpers such as isLikelyArticleUrl() must continue to behave exactly as before.

If wrappers are needed, use compatibility wrappers:

isLikelyArticleUrl(input): boolean

but ensure the wrapper preserves current behavior exactly.

5. Policy version constants

Add clear constants for policy versions, for example:
- CURRENT_PRODUCTION_URL_POLICY_VERSION
- CANDIDATE_URL_POLICY_VERSION
- URL_EVALUATION_DATASET_VERSION

Do not hardcode these strings in multiple places.

6. Tests

Add targeted tests proving:
- valid tuning and holdout datasets validate
- malformed labels are rejected or safely reported
- datasetVersion and split are preserved
- expectedAcceptanceClass is centralized and deterministic
- ENFORCED and SHADOW decisions can be represented for the same URL
- policyVersion, enforcementMode, reasonCode, and evidence are preserved
- candidate policy returns ACCEPT / REJECT / UNCERTAIN
- existing isLikelyArticleUrl() behavior is not broken
- evaluator functions are side-effect-free

Validation:
- Run npx nuxt typecheck.
- Run targeted tests for new utilities and existing article-url-policy tests.

Acceptance criteria:
- Dataset schema exists with tuning and holdout fixtures.
- expectedAcceptanceClass exists and is the source of truth for true-article metrics.
- Production and candidate policy decisions can be represented in a common format.
- Production evaluator is side-effect-free.
- Candidate evaluator supports ACCEPT / REJECT / UNCERTAIN.
- Existing production filtering behavior remains unchanged.
- No Prisma schema migration.
- No production gating or lifecycle refactor.
