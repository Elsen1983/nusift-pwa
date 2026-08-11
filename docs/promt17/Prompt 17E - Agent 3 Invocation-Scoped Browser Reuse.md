# Prompt 17E - Agent 3 Invocation-Scoped Browser Reuse

## Objective

Replace Agent 3's one-Chromium-per-article behavior with a Vercel-safe, invocation-scoped browser session that reuses one Chromium process and short-lived per-domain BrowserContext state inside one enrichment batch.

Do not persist browser/session objects across Function invocations or Workflow steps.

## Scope

Primary files:

- `server/utils/news-pipeline/article-content-browser-extractor.ts`
- `server/utils/news-pipeline/enrichment-runtime.ts`
- `server/utils/news-pipeline/browser-runtime.ts` only if required
- focused browser-extractor and enrichment-runtime tests
- internal Agent 3 route options only if a bounded batch browser budget must be passed explicitly

Do not modify Agent 2 browser lifecycle; Prompt 15C already owns it.

## Session abstraction

Introduce a narrow Agent 3 browser-session abstraction with:

- lazy Chromium launch;
- one Chromium process per `runEnrichmentBatch()` invocation;
- at most one active page at a time;
- one short-lived BrowserContext per normalized domain key;
- cookies/session state retained only inside that domain context;
- per-context navigation count;
- batch wall-clock deadline;
- explicit context retirement;
- exact final cleanup.

Recommended conservative defaults:

- maximum active contexts: 2;
- maximum active pages: 1;
- maximum navigations per context: bounded by the existing Agent 3 browser-attempt cap;
- no session lifetime beyond the current invocation;
- no persisted cookies/storage state.

Configuration may tighten these bounds but must not silently increase the current browser-attempt maximum.

## Required lifecycle

1. Static extraction runs first.
2. Browser session is created only after an eligible result passes Prompt 17A and Prompt 17D governor checks.
3. Chromium launches lazily on the first permitted browser attempt.
4. Reuse the domain's BrowserContext for later permitted articles from that domain.
5. Create a fresh page per article.
6. Close the page in `finally` after each article.
7. Retire a domain context after its navigation cap, publisher 429, corrupted context, or unrecoverable context error.
8. Close all contexts and then Chromium exactly once when the batch finishes or throws.
9. Browser runtime unavailable stops future launch attempts without being recorded as publisher failure.

If all permitted contexts are occupied, process sequentially rather than opening another Chromium.

## Standalone compatibility

Preserve the standalone article browser evaluator API. When called without an externally supplied session, it must own and close its own browser lifecycle exactly as before.

When called with a batch session, it must never close the shared Chromium itself.

Make lifecycle ownership explicit in types; do not infer it from nullable globals.

## Governor interaction

- Acquire one Prompt 17D permit per main-document navigation, not per browser launch.
- A reused context does not bypass the governor.
- An open circuit prevents use of an existing context.
- A browser main-document 429 retires the context and prevents later same-domain attempts.
- Release permit tokens exactly once even when page/context cleanup throws.

## Vercel resource requirements

- No module-global browser singleton.
- No expectation of warm-instance reuse.
- No cross-step browser handle serialization.
- One Chromium and one active page maximum.
- Navigation timeout must be the minimum of the configured article timeout and remaining batch wall-clock budget.
- Stop before launching or navigating when the remaining budget is insufficient.
- Cleanup must run within a reserved finalization window.

## Tests

Add fake-browser tests proving:

- two same-domain articles launch Chromium once and reuse one context;
- two domains launch Chromium once and create bounded separate contexts;
- every article gets a fresh page;
- pages close after success, rejection, timeout, and throw;
- contexts and browser close exactly once at batch end;
- standalone API still owns and closes its browser;
- batch API does not let a child evaluator close shared Chromium;
- 429 retires only the affected domain context and stops that domain;
- governor denial does not create/reuse a page;
- runtime unavailable stops later launch attempts;
- pre-launch and between-article wall-clock exhaustion create typed deferred outcomes;
- partial persisted outcomes and claim-loss counters remain correct.

Use deterministic clocks and mocked browser objects. No real-time sleeps.

## Acceptance criteria

- Agent 3 no longer launches one Chromium per browser-eligible article in a batch.
- Browser/session state never crosses an invocation boundary.
- Static-first, no-browser-on-429, governor, claim, CAS, persistence, publication, and Prompt 16 classification behavior remain correct.
- Focused tests, full Vitest, Nuxt typecheck, workflow bundle verification, production build, and `git diff --check` pass.

## Safety

- No schema/migration change.
- Do not increase browser concurrency.
- Do not add stealth, randomized identity, or session persistence.
- Do not commit or push.

## Completion response

Report launch/context/page counts for tested scenarios, ownership rules, Vercel resource bounds, validation results, and residual risks.
