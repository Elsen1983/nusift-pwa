# Prompt 17F - Feed-First Discovery Policy

## Objective

Make Agent 2 discovery conditional on the durable productivity of Agent 1 feeds so sources with working RSS/Atom feeds do not also generate unnecessary listing, sitemap, detail, and browser traffic.

Use existing `NewsSource` and `SourceCategory` feed-productivity fields. Do not hardcode BigNewsNetwork, Prog.hu, or Bytepoint URLs into generic pipeline logic.

## Scope

Primary areas:

- Agent 1 feed-productivity state updates
- Agent 2 target selection
- `NewsSource.currentFeedProductive`, `lastProductiveAt`, `consecutiveNonProductiveRuns`, `rssStatus`, and `nextRetryAt`
- corresponding `SourceCategory` fields
- static/headless queue eligibility and diagnostics
- source/category-level tests
- operational documentation for registering known feeds

Do not modify the Domain Governor, browser lifecycle, access classifier, or publication gate.

## Central policy

Create one pure/testable decision function equivalent to:

```text
shouldRunAgent2Discovery(target, now, policy) -> decision + bounded reason
```

The policy must distinguish:

- productive fresh feed: skip Agent 2;
- productive but stale feed: allow bounded Agent 2 fallback;
- feed rate limited with active Retry-After: defer both duplicate feed probes and Agent 2 fallback unless policy explicitly proves a safe independent host;
- nonproductive feed below threshold: keep Agent 1 primary and defer expensive fallback;
- repeatedly nonproductive feed: allow Agent 2;
- missing/invalid feed: allow Agent 2;
- user-requested/manual recovery: allow only through an explicit bounded override;
- source-level and category-level feed states independently.

Define and test the freshness and nonproductive thresholds. Do not infer freshness only from `rssStatus`; use the durable productivity timestamps/counters together.

## Required behavior

1. A fresh productive feed prevents duplicate Agent 2 static and headless discovery for the same target.
2. Skipping Agent 2 because the feed is productive is a neutral policy decision, not a success, failure, or hard-source recovery.
3. A skipped target creates only bounded diagnostics; it must not create `PENDING_HEADLESS` work.
4. A feed that becomes stale or repeatedly nonproductive becomes eligible for bounded Agent 2 fallback.
5. A later productive Agent 1 result restores feed-first behavior.
6. Category feed productivity must not suppress unrelated categories under the same source.
7. A source feed may cover source-level discovery without falsely claiming every category is covered unless provenance proves that scope.
8. Existing user subscriptions and source/category identity behavior remain unchanged.
9. Prompt 15 request budgets apply whenever Agent 2 is allowed.
10. Prompt 17 governor decisions still apply to every allowed request.

## Source-specific operational documentation

Document, without applying production DB changes:

- how to register a verified publisher feed for a source/category;
- how to confirm its first productive Agent 1 run;
- how to inspect `currentFeedProductive` and `lastProductiveAt`;
- how to verify Agent 2 was skipped for the correct target;
- how to roll back an incorrect feed mapping;
- why feed URL registration is data/configuration, not a hardcoded host exception.

Use BigNewsNetwork/Bytepoint-like fixtures in tests, not live publisher calls in the normal suite.

## Tests

Cover:

- fresh productive source feed skips Agent 2;
- fresh productive category feed skips only that category;
- stale feed permits fallback;
- repeated nonproductive runs permit fallback at the exact boundary;
- one transient empty run does not immediately trigger expensive discovery;
- active feed 429 cooldown does not fan out into listing/browser requests;
- manual override is explicit, bounded, and audited;
- skipped targets create no headless marker;
- restored productivity disables future fallback;
- source/category scope does not leak;
- feed-first decisions do not alter article persistence, access classification, publication, or subscription matching.

## Acceptance criteria

- One centralized policy controls Agent 2 target eligibility.
- Productive feeds materially reduce duplicate discovery requests.
- No publisher URL is hardcoded into generic scheduling logic.
- Full Vitest, Nuxt typecheck, workflow bundle verification, production build, and `git diff --check` pass.

## Safety

- Prefer no schema change; justify any migration before making it.
- No production feed registration or pipeline run.
- No live publisher test in the default suite.
- Do not commit or push.

## Completion response

Report the exact eligibility matrix, thresholds, target-scope rules, test counts, documentation added, and any source data that still requires manual configuration.
