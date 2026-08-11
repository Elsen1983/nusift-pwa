# Prompt 17 - Vercel-Compatible Domain Governance and Browser Efficiency

## Objective

Implement the high-value recommendations from the anti-bot resilience review without replacing NuSift's existing Agent 1/2/3 architecture, durable Workflow orchestration, claim/CAS protections, publication gate, or Prompt 16 access-classification model.

The implementation must remain compatible with Vercel Functions, Fluid Compute, Workflow DevKit, PostgreSQL/Prisma, `playwright-core`, and `@sparticuz/chromium`.

## Mandatory execution order

Run these prompts in order. Do not combine them into one large change.

1. `Prompt 17A - Agent 3 HTTP 429 No-Browser Invariant.md`
2. `Prompt 17B - Persistent Domain Governor Foundation.md`
3. `Prompt 17C - Static Network Integration.md`
4. `Prompt 17D - Browser Navigation Governance.md`
5. `Prompt 17E - Agent 3 Invocation-Scoped Browser Reuse.md`
6. `Prompt 17F - Feed-First Discovery Policy.md`
7. `Prompt 17G - Robots and Publisher Access Policy.md`
8. `Prompt 17H - Governance Observability and Admin Diagnostics.md`
9. `Prompt 17I - Shadow Rollout and Final Validation.md`

Each prompt assumes all earlier prompts have been implemented and validated.

## Existing behavior that must be preserved

- Agent 1 owns RSS/feed ingest.
- Agent 2 owns static discovery and headless discovery recovery.
- Agent 3 owns authoritative article extraction, enrichment, and access classification.
- Prompt 15A-15C request budgets, 429 evidence, persisted cooldown loading, marker CAS, partial-candidate persistence, target-scoped Agent 2 browser reuse, and wall-clock budgets remain authoritative.
- Prompt 16's `ArticleAccessClassification` is the only article access/paywall classifier.
- Network governance must not create a second paywall or access classifier.
- Agent 2 persistence must complete before marker resolution.
- Agent 3 claim ownership, token validation, final Article CAS, immediate per-outcome persistence, and claim-loss counter behavior must remain unchanged.
- Publication and notification gates must remain unchanged unless a prompt explicitly requires a tested compatibility adjustment.
- Existing SSRF validation in `server/utils/ssrf-guard.ts` must not be weakened.

## Vercel constraints

- Never rely on module-global memory for authoritative cooldown, concurrency, circuit, or lease state.
- Browser objects and BrowserContext instances must never be expected to survive a Function invocation or Workflow step boundary.
- Never hold a PostgreSQL transaction or advisory lock while sleeping, fetching, launching Chromium, or navigating.
- Use one Chromium process and one active page at a time in Agent 3 after Prompt 17E.
- Long cooldowns must result in durable deferral or Workflow sleep, not an in-process timer that holds a Function open.
- Keep payloads, logs, and artifacts bounded. Never persist response bodies, raw HTML, cookies, authorization headers, query values, endpoints containing secrets, or browser storage state.
- All migrations must be forward-only. Never rewrite an existing migration.

## Explicitly excluded

- Full Crawlee migration.
- Proxy rotation, Tor, free proxies, CAPTCHA solving, or automatic access-control bypass.
- Stealth plugins as default behavior.
- Random User-Agent rotation or fake human mouse/typing behavior.
- Cross-invocation browser-session persistence.
- Production database access, production migration deployment, application deployment, or production smoke testing without separate explicit authorization.

## Baseline validation for every prompt

At minimum run:

```text
npx vitest run <focused suites>
npx nuxt typecheck
git diff --check
```

Run the full Vitest suite when the prompt changes shared transport, persistence, workflow, browser runtime, or public/admin output. Run Prisma validation/generation when schema or generated client types change. Run the production build when browser/runtime bundling or Vercel-facing routes change.

## Completion reporting

Every implementation response must separate:

- implemented behavior;
- unit/mock verified behavior;
- PostgreSQL integration verified behavior;
- browser/runtime verified behavior;
- production deployed behavior;
- residual risks;
- migrations that still require deployment.

Do not report a mocked concurrency test as real PostgreSQL verification. Do not report a successful build as browser verification. Do not commit or push unless separately requested.
