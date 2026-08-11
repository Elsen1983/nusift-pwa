# Prompt 17G - Robots and Publisher Access Policy

## Objective

Add one shared, durable, publisher-aware robots/access policy for Agent 1/2/3 without weakening SSRF controls or turning robots handling into an anti-bot bypass.

The policy must be conservative, cached, governed, observable, and compatible with Vercel's stateless execution model.

## Scope

Audit existing robots handling in Agent 2 before adding anything. Reuse or refactor existing parsing rather than creating competing implementations.

Expected areas:

- existing robots/sitemap helpers in Agent 2
- a centralized publisher-network policy module
- durable bounded robots cache, either in a dedicated forward-only model or explicitly justified bounded storage
- Agent 1/2/3 pre-request policy checks
- browser main-navigation checks
- focused parser/cache/policy tests
- operational documentation

Do not add optional scrolling/load-more behavior in this prompt. This prompt is only access policy and compliance.

## Required policy

1. Fetch `robots.txt` only through the Prompt 17 governor.
2. Cache parsed policy durably with a bounded TTL, maximum 24 hours unless HTTP caching metadata requires a shorter safe value.
3. Cache only bounded parsed rules and non-sensitive metadata. Do not persist the raw file if it is unbounded.
4. Use one explicit crawler User-Agent configuration with a transparent product identifier. Do not rotate identities.
5. Apply the most specific applicable rule according to the maintained parser.
6. A disallowed path must:
   - perform no article/listing/browser request;
   - create a neutral policy-denied/deferred outcome;
   - never become paywall, publisher failure, hard-source failure, or browser-runtime failure;
   - remain visible in bounded diagnostics.
7. An unavailable robots file must follow an explicit documented policy. Distinguish 404/no-policy, timeout, 429, 403, malformed content, and governor denial.
8. Robots HTTP 429 opens the domain circuit and prevents immediate follow-up work.
9. Do not use browser fallback to retrieve robots after 403/429.
10. Explicit publisher RSS feeds remain feed-first, but their retrieval must still follow the documented policy and governor rules.

## Cache and concurrency

- Two concurrent workers must not stampede the same expired robots entry.
- Use a bounded token/lease or the existing domain lease; never hold a DB transaction during the fetch.
- A failed refresh may use a still-valid cached policy, but must not resurrect an expired deny/allow decision without explicit stale-cache rules.
- Cache writes require optimistic/token ownership where concurrent refreshes are possible.
- Normalize domain keys exactly as Prompt 17B.

## Integration boundaries

- Robots policy decides whether a URL may be requested.
- Domain Governor decides when it may be requested.
- SSRF guard decides whether the network target is safe.
- Prompt 16 classifier decides what returned article content means.

Do not merge these responsibilities.

## Tests

Add tests for:

- allow/disallow precedence;
- exact User-Agent and wildcard behavior;
- empty, missing, malformed, and oversized robots files;
- cache hit, expiry, refresh, and concurrent refresh suppression;
- robots 429 opens circuit and prevents follow-up requests;
- robots 403 is not a paywall;
- disallowed static and browser URLs execute no transport/navigation;
- policy denial creates no hard-source failure or success side effect;
- different hostnames remain isolated;
- no raw robots body, URL query, cookies, or headers are stored;
- existing sitemap discovery behavior remains correct.

Add an opt-in localhost-only integration test if a new durable cache model or lease is introduced.

## Acceptance criteria

- One shared robots policy is used by all publisher-facing stages.
- Existing Agent 2 robots/sitemap behavior is consolidated, not duplicated.
- Policy, governor, SSRF, and access-classification responsibilities remain separate.
- Prisma validate/generate when applicable, focused/full Vitest, Nuxt typecheck, workflow bundle verification, production build, and `git diff --check` pass.

## Safety

- Forward-only migration only if required.
- No production migration or publisher request.
- No bypass, stealth, proxy, or CAPTCHA behavior.
- Do not commit or push.

## Completion response

Report the parser/cache authority, exact unavailable-robots matrix, integration points, migration status, validation results, and residual compliance risks.
