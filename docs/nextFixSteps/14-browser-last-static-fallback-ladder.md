# Repair 14: Browser-Last Static Fallback Ladder

## Objective

Increase discovery/content yield with bounded publisher-declared static alternatives before Chromium, and reduce browser request amplification when browser work remains necessary.

## Prerequisites

Complete Repairs 12 and 13 first so existing-response evidence and known URLs are exhausted before adding fallback requests.

## Verified baseline

- Agent 2 already probes normal and news sitemap paths through governed, robots-aware discovery. Reuse it; do not add a second news-sitemap implementation.
- Feed discovery extracts WordPress/taxonomy hints but does not provide a general article-discovery WordPress REST fallback.
- Browser paths already block common heavy file extensions. They do not consistently classify requests by Playwright `resourceType()`.

## Scope

Primary areas:

- one ordered Agent 2/3 static fallback decision function
- publisher-declared AMP alternate handling
- bounded WordPress REST discovery when positively identified
- reuse/prioritization of existing news-sitemap results
- `resourceType()`-aware browser request blocking and amplification telemetry
- focused static and mocked-browser tests

Do not add scrolling, load-more interaction, CAPTCHA handling, stealth, proxy rotation, publisher-specific exceptions, or a competing robots/governor implementation.

## Ordered fallback policy

Use one testable order:

1. existing feed and feed-first result;
2. already-fetched listing anchors and Repair 12 structured evidence;
3. existing governed sitemap/news-sitemap evidence;
4. publisher-declared AMP alternate for an already-selected article;
5. positively identified, same-publisher WordPress REST endpoint with strict bounds;
6. browser fallback only when the existing eligibility policy says rendering can help.

Do not run every fallback unconditionally. Stop when bounded sufficiency is reached.

## Required behavior

1. Every added network request passes robots policy, SSRF validation, Domain Governor, redirect governance, request budget, timeout, and host scope independently.
2. AMP is fetched only from a validated `<link rel="amphtml">` or equivalent publisher-declared relation for the same article identity.
3. WordPress REST is attempted only after positive same-publisher evidence and uses bounded page size, page count, fields, and response bytes.
4. 403/429/governor defer stops further same-host fallback and never escalates to browser solely because static access was denied/rate-limited.
5. Existing news-sitemap code remains authoritative and must be prioritized rather than duplicated.
6. Candidate URLs from every fallback enter the same Repair 09 identity and Repair 13 known-URL prefilter path.
7. Browser routing must block safe heavy resource classes using `request.resourceType()` in addition to extension matching. Preserve scripts/XHR/fetch required for publisher rendering unless a tested allow/deny policy proves they are unnecessary.
8. Never block the main document, required stylesheet by default, or first-party API calls blindly.
9. Record bounded main-document, first-party, third-party, allowed, and blocked request counts without URLs/queries/headers.
10. Enforce target-level request, candidate, browser-attempt, and wall-clock caps.

## Tests

Cover:

- sufficient listing/structured evidence prevents all new fallback requests;
- existing news sitemap is reused and ordered before AMP/WP/browser;
- valid same-article AMP succeeds;
- external/malformed/mismatched AMP is rejected without transport;
- positive WordPress detection and bounded REST pagination;
- non-WordPress pages never probe `wp-json` speculatively;
- 403/429/governor defer stops the ladder;
- known fallback URLs are prefiltered before detail requests;
- `resourceType()` blocks image/font/media and extensionless heavy assets;
- document/script/XHR behavior remains sufficient for tested rendering;
- browser request amplification counters are bounded and redacted;
- no live publisher calls in the default suite.

## Acceptance criteria

- Chromium remains the final eligible fallback, not the second strategy.
- Added static requests are evidence-driven, bounded, governed, and stop early.
- Existing sitemap and browser policies are extended, not duplicated.
- Browser request amplification decreases without breaking representative rendering fixtures.
- Focused tests, Nuxt typecheck, workflow bundle verification, production build, and `git diff --check` pass.

## Safety and validation budget

- No production access, migration, live publisher test, commit, or push.
- No bypass, stealth, proxy, CAPTCHA, or rotating crawler identity behavior.
- Run affected static/browser tests only during implementation; reserve a full suite for tranche completion.

## Completion response

Report the exact fallback matrix, added request caps, AMP/WP eligibility evidence, browser resource policy, request-amplification deltas, tests run, and publishers/frameworks still unsupported.
