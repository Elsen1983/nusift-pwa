# Prompt 17D - Browser Navigation Governance

## Objective

Put every Agent 2 and Agent 3 publisher-facing Playwright main-document navigation behind the Prompt 17B Domain Request Governor.

This prompt governs existing browser behavior. It must not yet refactor Agent 3 from one-browser-per-article to batch-scoped browser reuse.

## Scope

Primary files:

- `server/utils/news-pipeline/article-discovery-browser.ts`
- `server/utils/news-pipeline/article-discovery-headless-queue.ts`
- `server/utils/news-pipeline/article-content-browser-extractor.ts`
- `server/utils/news-pipeline/enrichment-runtime.ts`
- `server/utils/news-pipeline/browser-runtime.ts` only if a narrow lifecycle hook is required
- directly related browser/queue/runtime tests

Do not change static fetch integration from Prompt 17C except to share common outcome types.

## Required behavior

1. Check the durable governor before launching Chromium when no browser session exists and before every `page.goto()`.
2. A denied navigation must:
   - launch no new browser when checked pre-launch;
   - create no context/page;
   - consume no browser-attempt budget;
   - consume no Agent-local navigation/request budget;
   - persist a retryable/deferred outcome with governor decision evidence;
   - remain distinct from browser runtime unavailable.
3. An allowed navigation must hold a tokenized lease only for the bounded navigation/evaluation interval.
4. Record and release in `finally` after navigation success, main-document HTTP error, timeout, exception, context failure, or cleanup failure.
5. Never hold a DB transaction/advisory lock during browser work.
6. A main-document HTTP 429 must open the circuit immediately, retire further same-domain browser work, and preserve bounded Retry-After evidence.
7. Third-party analytics/ad/media 429 responses must not open the publisher circuit.
8. Only a main-document response, or a narrowly proven first-party article-content endpoint, may produce authoritative browser rate-limit evidence.
9. HTTP 403 remains distinct. Browser recovery may continue only under the existing bounded 403/challenge policy.
10. Prompt 16 article access classification remains authoritative for page content. The governor only controls network execution.

## Browser request accounting

Add bounded per-navigation counters for:

- main-document requests;
- first-party subrequests;
- third-party subrequests;
- blocked heavy resources;
- main-document status;
- whether a publisher-domain 429 was observed.

Do not persist request URLs, endpoint paths, headers, payloads, response bodies, cookies, localStorage, or provider-specific challenge tokens.

Do not perform one governor DB acquisition per CSS/image/XHR subrequest. The durable lease governs the main navigation; subrequests are counted for diagnostics and budget awareness.

## Agent 2 invariants

- Preserve target-scoped lazy browser launch from Prompt 15C.
- Preserve one Chromium per target, isolated detail contexts/pages, wall-clock budget, and exact cleanup.
- Preserve static-first ordering.
- Preserve immediate stop after static or browser 429.
- Preserve partial candidate persistence and `PENDING_HEADLESS` marker state.
- Preserve marker CAS and no-false-success semantics.

## Agent 3 invariants

- Preserve Prompt 17A: static 429 never reaches browser governance because browser fallback is ineligible.
- Preserve browser attempt limits and source diversity.
- Preserve Article claim ownership and final CAS.
- A governor denial or browser 429 must not produce persisted/success counters or hard-source recovery side effects.

## Tests

Add deterministic tests proving:

- open circuit prevents browser launch;
- a permit is acquired before `page.goto()`;
- denied work consumes no browser budget;
- release happens exactly once on every exit path;
- token mismatch cannot release another worker's lease;
- main-document 429 opens the circuit and stops later same-domain navigation;
- third-party 429 is diagnostic only;
- another hostname can continue;
- browser runtime unavailable remains separate from governor denial;
- Prompt 15 Agent 2 cleanup and marker tests still pass;
- Prompt 16 interstitial/paywall outcomes are unchanged;
- stored diagnostics are bounded and secret-free.

Use mocked browser/network events and fake clocks. Do not add slow live navigation tests to the normal unit suite.

## Acceptance criteria

- Every Agent 2/3 publisher main-document navigation is governed exactly once.
- No browser launches merely to discover that a domain circuit is already open.
- Browser subrequests are bounded/accounted without per-subrequest DB chatter.
- Full Vitest, Nuxt typecheck, workflow bundle verification, production build, and `git diff --check` pass.

## Safety

- No new migration in this prompt.
- Do not enable enforce mode in production.
- Do not add stealth or proxy behavior.
- Do not commit or push.

## Completion response

Report the navigation inventory, ordering evidence, exact 429/403 behavior, cleanup proof, validation results, and residual gaps.
