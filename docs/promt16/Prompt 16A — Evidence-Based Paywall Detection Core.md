Prompt 16A — Evidence-Based Paywall Detection Core

Objective
---------

Replace the current keyword-driven paywall classification with a centralized, evidence-based article-access classifier.

This phase must fix the core false-positive behavior without changing Prisma schema, database migrations, dashboard behavior, or existing production records.

Confirmed defect
----------------

The current Agent 3 extractor contains a generic strong signal:

/paywall/i

in:

server/utils/news-pipeline/article-content-extractor.ts

It scans cleaned whole-page body text. Therefore a freely accessible article discussing a paywall, subscription controversy, Netflix subscription, or another website's paywall can be classified as paywalled.

The same Agent 3 signal list also mixes unrelated technical states into paywall detection:

- access denied;
- CAPTCHA;
- robot challenge;
- blocked by security;
- JavaScript-required interstitial;
- ad-blocker warning.

These are not equivalent to an article paywall.

Required implementation
-----------------------

1. Create one centralized article-access classification module.

Suggested maintained file:

server/utils/news-pipeline/article-access-classification.ts

The module must return a structured result rather than a boolean.

Use a model equivalent to:

ArticleAccessClassification:
- ACCESSIBLE
- PAYWALL_BLOCKED
- METERED_OR_DECLARED
- INTERSTITIAL_OR_CHALLENGE
- HTTP_ACCESS_BLOCKED
- UNKNOWN

The result must include bounded evidence:

- classification;
- confidence: HIGH | MEDIUM | LOW;
- access detectorVersion (the persisted `ARTICLE_ACCESS_DETECTOR_VERSION`, separate from `extractorVersion`);
- evidence entries;
- contradicting evidence;
- whether the evidence was article-scoped;
- whether usable full body text was extracted;
- whether body truncation was detected;
- whether an article-scoped gate or overlay was detected.

Do not store raw HTML, full body text, secrets, query values, cookies, or unbounded DOM content in evidence.

2. Remove generic topic words as decisive paywall evidence.

The following must not independently classify an article as paywalled:

- paywall;
- paywalled;
- behind a paywall;
- subscription;
- Netflix subscription;
- premium;
- subscriber;
- member;
- subscribe;
- newsletter;
- quoted statements about another service requiring payment.

These may be stored only as low-confidence topic signals or ignored.

3. Separate technical access failures from paywalls.

Map these correctly:

- CAPTCHA / robot verification / browser challenge:
  INTERSTITIAL_OR_CHALLENGE

- HTTP 401/403 or explicit request access denial:
  HTTP_ACCESS_BLOCKED

- JavaScript challenge or non-final shell:
  INTERSTITIAL_OR_CHALLENGE

- ad-blocker warning without an article-specific subscription gate:
  UNKNOWN or INTERSTITIAL_OR_CHALLENGE, depending on page structure

None of these may set paywall=true merely because article content was unavailable.

Preserve Prompt 14 HTTP 202 interstitial behavior and bounded retry semantics.

4. Require article-specific evidence for PAYWALL_BLOCKED.

PAYWALL_BLOCKED should require a combination such as:

- article body is missing or materially truncated;
- an access CTA is inside or immediately adjacent to the selected article container;
- the CTA explicitly says that this article/story/content requires subscription, membership, sign-in, or payment;
- an overlay/gate is associated with the article body;
- hidden or truncated continuation evidence exists.

A navigation Subscribe button, footer CTA, newsletter widget, account menu, advertisement, or unrelated recommendation card must not qualify.

5. Treat extracted full body as strong contrary evidence.

A substantial, usable, multi-paragraph article body with no article-scoped gate must strongly support ACCESSIBLE.

If the body is fully extracted and the only positive signal is:

- the word paywall;
- discussion of subscription;
- an unrelated Subscribe navigation element;
- non-article page chrome;

the final classification must be ACCESSIBLE and isPaywall must eventually be false.

Do not automatically classify every extracted body as accessible. Preserve detection of soft or metered paywalls where a full body may be present but a genuine article-specific access restriction is still proven.

6. Parse structured metadata semantically.

Do not regex the entire HTML for JSON-LD paywall metadata.

Parse JSON-LD safely and inspect only supported article nodes:

- Article
- NewsArticle
- ReportageNewsArticle
- AnalysisNewsArticle

Support arrays and @graph.

An `isAccessibleForFree: false` or `PaywalledContent` signal is valid only when it belongs to the article node corresponding to the current canonical/resolved URL or to a clearly related `hasPart` entry.

Ignore:

- unrelated article nodes;
- recommended articles;
- navigation metadata;
- WebPage-only metadata;
- malformed JSON-LD;
- publisher-global template metadata;
- nodes whose canonical identity conflicts with the extracted article.

Structured metadata alone should normally produce METERED_OR_DECLARED, not PAYWALL_BLOCKED, unless runtime access-block evidence also exists.

7. Preserve compatibility and public semantics.

The current Agent 1 and Agent 2 production paths use `classifyEarlyAccessHint()` for bounded early classification and evidence. The existing `hasStrongPaywallHint()` API may remain only as a compatibility wrapper for tests, legacy callers, or older integrations; it is not the authoritative Agent 1/2 production API. The wrapper must not reintroduce broad keyword matching.

Public blocking UI is controlled only by `accessClassification === "PAYWALL_BLOCKED"`. The legacy `isPaywall` boolean remains a persistence/API compatibility field. Missing or malformed `accessClassification` must not fall back to `isPaywall=true`, and `METERED_OR_DECLARED` is always readable and non-blocking.

Do not change Prisma schema or migrations.

Do not change feed API response shape in this phase.

8. Add regression tests.

Add generic, publisher-independent fixtures covering:

A. A fully accessible article whose topic repeatedly includes:
- paywall;
- Netflix subscription;
- behind a paywall;
Expected: ACCESSIBLE.

B. A freely accessible article quoting:
"Subscribe to continue reading"
about another website.
Expected: ACCESSIBLE or UNKNOWN, never PAYWALL_BLOCKED.

C. Navigation/footer Subscribe CTA plus full article body.
Expected: ACCESSIBLE.

D. Article-scoped "Subscribe to continue reading" gate plus truncated body.
Expected: PAYWALL_BLOCKED.

E. Valid article-scoped JSON-LD with `isAccessibleForFree: false`, full readable body, and no gate.
Expected: METERED_OR_DECLARED, not PAYWALL_BLOCKED.

F. `isAccessibleForFree: false` on an unrelated JSON-LD article.
Expected: ignored.

G. CAPTCHA/robot challenge.
Expected: INTERSTITIAL_OR_CHALLENGE.

H. HTTP 403 page.
Expected: HTTP_ACCESS_BLOCKED.

I. HTTP 202 interstitial.
Expected: INTERSTITIAL_OR_CHALLENGE with existing Prompt 14 retry behavior.

J. Malformed JSON-LD.
Expected: no crash and no paywall classification from the malformed data.

K. Full body plus erroneous publisher-global paywall metadata.
Expected: no blocking PAYWALL_BLOCKED classification.

L. Genuine paywall with truncated body and article-scoped gate.
Expected: PAYWALL_BLOCKED.

9. Preserve existing behavior outside paywall classification.

Do not regress:

- body extraction;
- JSON-LD articleBody extraction;
- browser fallback;
- HTTP 202 handling;
- 403/429 cooldown rules;
- retry dispositions;
- publication-state transitions;
- claim/CAS protections;
- persisted-only telemetry;
- URL policy behavior.

Validation
----------

Run:

- new article-access classifier tests;
- paywall detection tests;
- article-content extractor tests;
- browser extractor tests;
- Prompt 14 interstitial tests;
- enrichment runtime tests;
- Nuxt typecheck;
- Prisma validate;
- git diff --check.

Constraints
-----------

- No production database/API/Vercel/secrets access.
- No Prisma schema or migration changes.
- No publisher-specific Bytepoint rule.
- No live-network-dependent regression test.
- Preserve all unrelated worktree changes.
- Preserve the existing Prompt 14/14A/14B work.
- Do not modify docs/reportAboutPaywall.md in this phase.
- Do not commit or push.

Final report
------------

Report:

1. confirmed root cause;
2. new classification model;
3. decisive and non-decisive evidence;
4. full-body contradiction behavior;
5. JSON-LD scoping;
6. challenge/403 separation;
7. exact regression tests;
8. validation results;
9. schema status;
10. production-access status;
11. confirmation that no commit or push occurred.