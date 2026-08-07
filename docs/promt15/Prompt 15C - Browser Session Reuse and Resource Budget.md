Prompt 15C - Browser Session Reuse and Resource Budget

Refactor Agent 2 browser discovery so article-detail recovery does not launch a new browser process for every URL.

Prompts 1 and 2 have already corrected request budgets, structured 429 handling, cooldown behavior, and artifact state transitions. Preserve those semantics exactly.

This task is a bounded browser-runtime efficiency and request-control refactor. It must not change candidate eligibility or persistence behavior.

Verified problem

`evaluateArticleLinkCandidateWithBrowser()` currently launches and closes a browser for each article URL.

For multiple recovery URLs this causes:

- repeated Chromium startup;
- avoidable CPU and memory usage;
- repeated browser initialization traffic;
- weaker control over the total target-level browser request budget.

Primary files to inspect

- `server/utils/news-pipeline/article-discovery-browser.ts`
- `server/utils/news-pipeline/article-discovery-headless-queue.ts`
- `server/utils/news-pipeline/article-discovery-browser.test.ts`
- `server/utils/news-pipeline/article-discovery-headless-queue-browser.test.ts`
- shared browser runtime modules and test injection hooks

Required implementation

1. Introduce an explicit target-scoped browser session API.

The headless queue should be able to:

- launch one browser for one target;
- evaluate a bounded number of detail URLs;
- close the browser exactly once in `finally`.

Do not create a process-global browser singleton.

2. Isolate detail evaluations safely.

Use either:

- one fresh page per article inside a target-scoped context; or
- one fresh context per article inside the same browser.

Choose the lowest-cost option that still prevents cookies, storage, redirects, and page state from leaking incorrectly between article evaluations.

Document the isolation decision.

3. Preserve the existing standalone evaluator API where required.

Tests or isolated callers may still need a convenience function that owns its browser lifecycle.

Avoid duplicating extraction and candidate-building logic. The target-scoped and standalone APIs must call the same underlying evaluation implementation.

4. Enforce browser resource filtering consistently.

Continue blocking images, fonts, media, and other clearly unnecessary resources.

Evaluate whether analytics, advertising, tracking, and unrelated third-party requests can be blocked safely.

Do not block publisher-controlled scripts or XHR requests when they may be required to render article metadata or body content.

5. Add target-level browser bounds.

Preserve or strengthen:

- maximum detail evaluation count;
- navigation timeout;
- overall target browser time budget;
- first-429 immediate stop;
- host cooldown behavior.

The browser session must not continue after rate limiting or after its target-level time/request budget is exhausted.

6. Preserve all persistence and lifecycle semantics from Prompt 2.

This refactor must not change:

- candidate acceptance rules;
- static-first evaluation order;
- duplicate handling;
- `PENDING_HEADLESS` behavior;
- CAS predicates;
- resolved counters;
- success logs;
- cooldown evidence;
- hard-source side effects.

Required regression tests

Add tests proving:

1. Multiple detail evaluations launch one browser for the target.
2. The browser closes exactly once after success.
3. The browser closes exactly once after an exception.
4. Pages or contexts are closed between evaluations.
5. A 429 stops later navigation immediately.
6. Timeout exhaustion stops later navigation.
7. Resource filtering remains installed.
8. Candidate results remain identical to the standalone evaluator.
9. Browser launch failure remains a runtime failure, not a fake candidate failure.
10. No raw HTML, DOM dump, screenshot, credentials, or browser storage is persisted.
11. Existing Agent 2 counters and artifact transitions remain unchanged.

Validation

Run:

- browser discovery tests;
- headless queue browser tests;
- browser runtime tests;
- full Vitest suite;
- `npx nuxt typecheck`;
- `git diff --check`;
- production build if browser-runtime bundling changed.

Report:

- old versus new browser launch count;
- isolation strategy;
- resource-blocking strategy;
- test results;
- build result;
- remaining runtime risks.

Safety constraints

- Preserve Prompt 1 and Prompt 2 behavior.
- Do not add a global browser singleton.
- Do not weaken SSRF or canonical-host checks.
- Do not change Agent 1, Agent 3, Prisma schema, or migrations.
- Do not access production systems.
- Do not commit or push.