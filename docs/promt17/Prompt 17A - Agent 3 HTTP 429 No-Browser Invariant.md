# Prompt 17A - Agent 3 HTTP 429 No-Browser Invariant

## Objective

Correct the remaining Agent 3 rate-limit amplification defect before introducing shared domain governance.

The current implementation treats both HTTP 403 and HTTP 429 as browser-fallback eligible. HTTP 429 must instead be an unconditional no-browser boundary: preserve structured rate-limit evidence, apply/defer according to the existing Agent 3 retry policy, and perform no browser work for that article or later same-host articles in the batch.

## Scope

Inspect and update only the Agent 3 browser-fallback eligibility, batch orchestration, retry/cooldown telemetry, and directly related tests.

Primary files:

- `server/utils/news-pipeline/article-content-browser-extractor.ts`
- `server/utils/news-pipeline/article-content-browser-extractor.test.ts`
- `server/utils/news-pipeline/enrichment-runtime.ts`
- `server/utils/news-pipeline/enrichment-runtime.test.ts`
- `server/utils/news-pipeline/agent3-retry-policy.ts`
- directly related diagnostics normalizers only if required

Do not implement the shared Domain Governor in this prompt.

## Required behavior

1. `isBrowserFallbackEligibleForFailure()` must return `false` for HTTP 429.
2. HTTP 403 may remain browser eligible only under the existing bounded policy.
3. HTTP 200 rendering/interstitial failures may remain browser eligible according to Prompt 16 classification and existing retry policy.
4. A static HTTP 429 must:
   - retain status 429;
   - retain bounded `Retry-After`/`retryAfterAt` evidence;
   - create the existing retry/defer outcome;
   - consume zero browser-attempt budget;
   - launch no browser;
   - create no browser context or page;
   - stop later browser attempts for the same hostname in the current batch.
5. A static 429 must not become `browser_runtime_unavailable`, `INTERSTITIAL_OR_CHALLENGE`, `PAYWALL_BLOCKED`, or successful recovery.
6. Preserve Prompt 16's access classification. Network rate limiting is not paywall evidence.
7. Preserve durable per-article persistence and claim-loss behavior. Counters and logs must reflect only persisted outcomes.

## Required regression tests

Add tests proving:

- HTTP 429 is not browser eligible;
- HTTP 403 remains browser eligible where previously supported;
- an HTTP 200 JS/cookie interstitial remains browser eligible;
- static 429 invokes no browser launcher;
- static 429 does not decrement the browser-attempt budget;
- static 429 prevents a later same-host article from attempting browser recovery;
- another host remains independently processable;
- `Retry-After` delta-seconds, HTTP-date, and fallback evidence survive persistence;
- static 429 does not produce browser success/failure counters;
- claim loss after a persisted 429 does not produce success counters;
- existing Prompt 16 classification and Prompt 15 Agent 2 behavior do not regress.

Use deterministic clocks. Do not add real-time sleeps.

## Acceptance criteria

- There is no production code path that launches Agent 3 browser fallback directly because the static result is HTTP 429.
- No test or compatibility wrapper still asserts that 429 is browser eligible.
- The outcome remains retryable/deferred and diagnostically accurate.
- Full Vitest, Nuxt typecheck, production build, and `git diff --check` pass.

## Safety

- No Prisma schema or migration change.
- No production access.
- Do not modify Agent 2 browser-session lifecycle.
- Do not implement stealth, proxy, CAPTCHA, or User-Agent rotation.
- Do not commit or push.

## Completion response

Report exact changed files, the final 403/429/200-interstitial eligibility matrix, focused/full test counts, build/typecheck results, and residual risks.
