# Prompt 17C - Static Network Integration

## Objective

Integrate the Prompt 17B Domain Request Governor into all relevant static outbound news-pipeline requests while preserving existing SSRF protection, Agent-specific request budgets, Retry-After evidence, persistence ordering, and durable retry behavior.

Start in shadow mode. Enforce behavior must exist behind configuration but must not be enabled by default.

## Scope

Audit every news-pipeline `safeFetch()` call in:

- `server/utils/news-pipeline/ingest.ts`
- `server/utils/news-pipeline/article-discovery.ts`
- `server/utils/news-pipeline/article-discovery-helpers.ts`
- `server/utils/news-pipeline/article-content-extractor.ts`
- directly related feed/browser-feed resolver paths if they perform pipeline HTTP requests
- `server/utils/ssrf-guard.ts` only if a backward-compatible pipeline hook is necessary

Do not govern unrelated authentication, geolocation, user-facing API, email, or push requests.

Do not change browser lifecycle or `page.goto()` behavior in this prompt.

## Integration design

Prefer a pipeline-specific governed fetch adapter rather than making every application `safeFetch()` call governed.

Each request must carry bounded context:

- agent/stage;
- purpose such as feed, listing, robots, sitemap, article detail, or article extraction;
- normalized domain key;
- pipeline run ID when available;
- source/category/article identifier when available;
- governor mode.

Never store the complete request URL or query string in governor state or telemetry.

## Required ordering

For every actual outbound request:

1. Parse and validate the URL.
2. Run existing SSRF checks or preserve `safeFetch()`'s pre-request checks.
3. Check the Agent-local request budget without permanently consuming a slot yet.
4. Ask the Domain Governor for a permit.
5. If enforce mode defers, perform no network request and do not consume the Agent-local HTTP budget.
6. Immediately before transport, consume exactly one logical Agent-local request slot.
7. Execute the existing SSRF-safe request.
8. Record the bounded network outcome.
9. Token-validating release must happen in `finally`.

One logical `safeFetch()` invocation remains one Agent-local request-budget unit, including its existing internally validated redirect handling. Do not silently redefine Prompt 15 accounting.

## Response policy

- 429: record structured evidence, open the durable circuit, stop same-domain work, and defer. Never trigger browser work.
- 403: record separately; preserve existing Agent-specific challenge/denial handling.
- 2xx: record success. A successful response may close a valid half-open probe.
- 3xx: preserve existing SSRF-safe redirect behavior.
- 5xx, timeout, DNS, abort, and network errors: record their actual class without inventing HTTP status.
- Governor denial is not a publisher failure and must not increment hard-source failure streaks.
- Governor persistence failure in enforce mode is retryable/deferred and must not be presented as an HTTP failure.

## Agent-specific invariants

Agent 1:

- Feed retries must not bypass an open circuit.
- A 429 must prevent later same-domain feed/front-page/detail requests in the batch.
- Existing candidate persistence and RSS status transitions remain accurate.

Agent 2:

- Prompt 15 request/evaluation/accepted caps remain independent.
- Governor denial must not create a fake request-budget exhaustion result.
- Partial accepted candidates remain persistable.
- Retryable/incomplete discovery stays `PENDING_HEADLESS`.
- Existing marker CAS and persisted cooldown evidence remain compatible.

Agent 3:

- Prompt 17A no-browser-on-429 remains absolute.
- Existing claims, final Article CAS, and immediate outcome persistence remain unchanged.
- Governor denial produces no success counter and no hard-source success/failure side effect.

## Tests

Add focused adapter tests and real orchestration-level tests proving:

- shadow mode observes but does not suppress requests;
- enforce mode suppresses an open-circuit request before transport;
- denied requests consume no Agent-local request slot;
- allowed requests consume exactly one slot;
- release occurs after success, throw, timeout, abort, and parsing failure;
- stale lease tokens cannot mutate state;
- Agent 1 same-host fan-out stops after 429;
- Agent 2 partial persistence and marker state remain correct;
- Agent 3 429 launches no browser;
- different domains remain independent;
- governor DB failure is classified distinctly from publisher/network failure;
- no logs/artifacts contain full URLs, query values, headers, cookies, or bodies.

## Acceptance criteria

- Every relevant static pipeline request is governed exactly once.
- No unrelated application fetch is governed.
- Existing Prompt 15 and Prompt 16 behavior is unchanged except for explicit governor defer decisions.
- The migration from Prompt 17B is documented as a deployment prerequisite before enforce-capable application code.
- Focused tests, full Vitest, Nuxt typecheck, workflow bundle verification, production build, and `git diff --check` pass.

## Safety

- Default mode remains shadow/off.
- No production migration or deployment.
- No browser refactor.
- No commit or push.

## Completion response

Provide a complete call-site inventory, prove which requests are governed and excluded, report test counts, and identify any ungoverned pipeline request that remains.
