Prompt 16B — Pipeline Integration, Persistence, and Admin Diagnostics

Prerequisite
------------

Prompt 16A must already be implemented and reviewed.

Objective
---------

Integrate the centralized article-access classifier across Agent 1, Agent 2, Agent 3, persistence, artifacts, admin diagnostics, and the existing boolean `isPaywall` compatibility field.

The pipeline must preserve evidence and must not convert an early-stage hint into a definitive blocking decision without Agent 3 confirmation. Public blocking UI is controlled only by `accessClassification === "PAYWALL_BLOCKED"`; the legacy `isPaywall` boolean is a persistence/API compatibility field, not a public blocking fallback. Missing or malformed `accessClassification` must not block, and `METERED_OR_DECLARED` is always readable and non-blocking.

Required implementation
-----------------------

1. Define stage responsibilities.

Agent 1 and Agent 2:
- may produce an early PAYWALL_HINT or declared-access hint;
- must not claim that runtime access was definitively blocked unless they observed article-scoped blocking evidence;
- must preserve bounded evidence and the access detector version;
- must not classify from complete feed XML or unrelated page chrome.

Agent 3:
- is the authoritative runtime classifier;
- evaluates extracted body, selected article container, article-scoped gate evidence, structured metadata, HTTP status, browser result, and contradicting evidence;
- may confirm, downgrade, or clear early hints.

2. Integrate Agent 1.

Update the RSS and HTML fallback paths in:

server/utils/news-pipeline/ingest.ts

Requirements:

- Evaluate only the current feed item or current article detail page.
- Do not scan an entire RSS document for paywall evidence.
- Do not treat topic discussion as article access restriction.
- Preserve the early classifier result and bounded evidence in existing candidate signals/provenance/artifact fields.
- Avoid schema changes.
- Continue populating the legacy `isPaywall` boolean conservatively for persistence/API compatibility; it is not a public blocking-UI authority.
- A low/medium hint must not become a definitive true unless the current item contains strong article-specific restriction evidence.

3. Integrate Agent 2.

Update:

server/utils/news-pipeline/article-discovery-helpers.ts
server/utils/news-pipeline/article-discovery.ts
server/utils/news-pipeline/artifacts.ts

Requirements:

- Replace whole-HTML regex matching with the structured classifier.
- Parse article-scoped metadata.
- Store bounded classification evidence in existing discovery artifacts.
- Preserve normal candidate persistence and URL-policy behavior.
- Do not use navigation, footer, newsletter, recommendation, or unrelated JSON-LD evidence as a definitive paywall.

4. Integrate Agent 3.

Update:

server/utils/news-pipeline/article-content-extractor.ts
server/utils/news-pipeline/enrichment-runtime.ts
server/utils/news-pipeline/enrichment-persist.ts
server/utils/news-pipeline/enrichment.ts

Requirements:

- Use the Prompt 15A classification as the authoritative access result.
- Preserve full evidence in a bounded enrichment outcome/artifact summary.
- Keep existing retry and browser-fallback behavior.
- PAYWALL_BLOCKED remains terminal only when blocking evidence is genuinely article-specific.
- INTERSTITIAL_OR_CHALLENGE follows Prompt 14 bounded browser-recovery behavior.
- HTTP_ACCESS_BLOCKED follows existing 403/429 handling and is not a paywall.

5. Correct `isPaywall` compatibility semantics.

The existing database boolean and feed API must remain compatible.

Map the structured result as follows:

- PAYWALL_BLOCKED -> isPaywall=true
- METERED_OR_DECLARED -> preserve as evidence, always readable and non-blocking; never show the blocking overlay
- ACCESSIBLE -> isPaywall=false
- INTERSTITIAL_OR_CHALLENGE -> do not infer paywall
- HTTP_ACCESS_BLOCKED -> do not infer paywall
- UNKNOWN -> preserve the existing value only when no stronger Agent 3 evidence exists

Agent 3 must clear an early true when:

- a substantial usable body was extracted;
- no article-scoped paywall gate was found;
- no confirmed blocking evidence remains.

Agent 3 must not clear a genuine article-scoped PAYWALL_BLOCKED decision merely because browser DOM exposed a short preview.

6. Preserve provenance.

The final enrichment outcome must explain:

- previous isPaywall value;
- early-stage classification;
- Agent 3 classification;
- selected final boolean;
- access detector version (`ARTICLE_ACCESS_DETECTOR_VERSION`);
- evidence codes;
- contradicting evidence;
- override reason;
- whether a full usable body was extracted.

Do not store raw HTML or full article text in evidence.

7. Fix UI semantics.

Review:

app/components/NewsCard.vue
app/components/ArticleReaderModal.vue
app/components/PaywallModal.vue
app/pages/dashboard/dashboard-main.vue

Requirements:

- Blocking paywall UI must be driven only by `accessClassification === "PAYWALL_BLOCKED"`. Missing or malformed classification must not fall back to `isPaywall=true`.
- A merely declared/metered status must not cover an otherwise readable article with the current blocking overlay.
- Preserve existing UI for confirmed paywalled articles.
- Do not remove existing dashboard behavior unrelated to paywall handling.

If introducing a separate UI label for METERED_OR_DECLARED without schema changes is not practical, keep it admin-diagnostic-only and leave the public `isPaywall` boolean false unless blocking is confirmed.

8. Add admin diagnostics.

Extend existing admin inspection and Agent 3 diagnostics to display bounded fields:

- final access classification;
- access detector version (`ARTICLE_ACCESS_DETECTOR_VERSION`), kept separate from `extractorVersion`;
- confidence;
- source stage;
- evidence codes;
- contradicting evidence;
- full body extracted: yes/no;
- article-scoped gate: yes/no;
- previous and final isPaywall values;
- override reason.

Never expose:

- raw HTML;
- body text;
- cookies;
- authorization headers;
- tokens;
- unredacted query parameters.

9. Add integration tests.

Cover at minimum:

A. Agent 1 hint true, Agent 3 extracts full body with no gate:
- final isPaywall=false;
- override evidence stored.

B. Agent 2 structured declaration, Agent 3 finds full body:
- classification METERED_OR_DECLARED or ACCESSIBLE;
- no blocking overlay; `METERED_OR_DECLARED` remains readable.

C. Agent 3 confirms truncated body plus article-scoped subscription gate:
- final isPaywall=true;
- PAYWALL_BLOCKED evidence stored.

D. Article discusses a Netflix paywall:
- full body persists;
- final isPaywall=false;
- published article remains readable.

E. CAPTCHA/403:
- no paywall boolean;
- correct technical outcome and retry behavior.

F. Existing true plus UNKNOWN Agent 3 result:
- no unsafe automatic clearing.

G. Existing true plus strong ACCESSIBLE Agent 3 result:
- clear to false.

H. Existing false plus genuine PAYWALL_BLOCKED:
- set true.

I. Evidence remains bounded and sanitized.

J. Feed API remains backward-compatible.

K. Admin diagnostics show the reason without exposing sensitive content.

Validation
----------

Run:

- Agent 1 ingest tests;
- Agent 2 discovery and persistence tests;
- article-access classifier tests;
- article-content extractor tests;
- enrichment persistence/runtime tests;
- feed API tests;
- admin inspection tests;
- Prompt 14 retry/telemetry tests;
- Nuxt typecheck;
- Prisma validate;
- git diff --check;
- production build;
- workflow bundle guard.

Constraints
-----------

- No Prisma schema or migration changes.
- No production access.
- No publisher-specific exceptions.
- No live-network-dependent tests.
- Preserve Prompt 14 behavior and unrelated worktree changes.
- Keep docs/reportAboutPaywall.md aligned with the implemented semantics.
- Do not commit or push.

Final report
------------

Clearly separate:

1. Agent 1 behavior;
2. Agent 2 behavior;
3. Agent 3 authority;
4. final boolean compatibility mapping;
5. artifact/provenance evidence;
6. dashboard behavior;
7. admin diagnostics;
8. integration tests;
9. validation results;
10. remaining gaps;
11. schema/production/git status.