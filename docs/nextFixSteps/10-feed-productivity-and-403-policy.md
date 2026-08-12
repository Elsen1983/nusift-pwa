# Repair 10: Feed Productivity Demotion and HTTP 403 Cooldown Policy

## Objective

Make feed-productivity state transitions resistant to transient failures and add a conservative, durable HTTP 403 response policy that prevents repeated publisher hammering without misclassifying access outcomes.

This is the final repair in the six-step batch because it changes scheduling/network policy rather than local parsing or accounting.

## Scope

Primary areas:

- Agent 1 source/category feed-productivity updates
- feed-first Agent 2 eligibility decisions
- Domain Governor 403 streak and circuit transitions
- Agent 1/2/3 governed static requests and browser main navigation outcomes
- bounded telemetry/admin diagnostics
- policy unit tests and workflow-level regressions

Do not change robots parsing, SSRF policy, Prompt 16 article access taxonomy, browser lifecycle, charset decoding, article identity, publication gate, or user subscription matching.

## Feed-productivity policy

Define one pure transition function using the durable source/category state and current Agent 1 outcome.

It must distinguish:

- productive feed result;
- one transient empty/timeout/5xx/technical failure;
- repeated confirmed nonproductive results;
- invalid or removed feed;
- HTTP 429 with active Retry-After;
- governor or robots defer;
- persistence failure/unknown state;
- manual feed remapping.

Required behavior:

1. One transient empty run or technical failure must not immediately erase previously proven productivity or fan out into Agent 2 listing/browser work.
2. Repeated, independently confirmed nonproductive runs may demote productivity at one exact tested threshold.
3. A later productive result resets the nonproductive streak and restores feed-first skipping.
4. HTTP 429/governor/robots defer is neutral and must not increment nonproductive streaks.
5. Source and category state must remain independently scoped. A source-level feed must not claim category coverage without provenance.
6. State writes must be persistence-aware and CAS-safe where concurrent runs can occur.

## HTTP 403 policy

Define one durable policy separate from Prompt 16 article access classification:

1. A single 403 is evidence, not automatically a paywall or permanent source failure.
2. Consecutive authoritative 403 responses for the same normalized domain may open a bounded circuit at an explicit threshold.
3. Success, 429, and technical/network failures must transition/reset 403 streaks according to one tested matrix.
4. Static and browser layers must not count the same authoritative 403 response twice.
5. While the 403 circuit is open, later requests defer neutrally and do not consume Agent 3 extraction attempts.
6. Half-open probe ownership must use the existing governor lease/CAS mechanism.
7. Diagnostics may say the publisher likely blocks the configured crawler identity, but must not assert paywall or malicious behavior.
8. Do not use browser escalation solely to retry repeated 403 responses unless the existing bounded policy explicitly proves a JS/cookie interstitial case.

## Configuration

- Use bounded validated configuration for thresholds and cooldown durations.
- Defaults must be conservative and documented.
- No publisher-specific URL hardcoding.
- Preserve `off`, `shadow`, and `enforce` governor semantics. Shadow records bounded would-defer evidence without suppressing requests.

## Tests

Cover:

- productive feed followed by one transient empty run remains feed-first;
- exact nonproductive demotion boundary;
- productive recovery resets state;
- 429, governor defer, robots defer, and persistence failure are neutral;
- source/category scope isolation;
- first and threshold 403 transitions;
- OPEN, HALF_OPEN, successful probe, repeated 403, and expiry;
- 403 de-duplication across transport/governor/derived layers;
- claim loss and persistence failure suppress durable counters;
- no paywall, hard-source, or browser-runtime misclassification;
- shadow versus enforce behavior;
- public feed and subscription behavior remain unchanged.

## Acceptance criteria

- Transient feed failures do not trigger expensive duplicate discovery.
- Confirmed persistent nonproductivity eventually enables bounded Agent 2 fallback.
- Repeated 403 responses produce a durable, polite cooldown rather than daily repeated traffic.
- Feed, governor, access classification, and hard-source responsibilities remain separate.
- Focused tests pass, then run the full Vitest suite once for the completed six-repair batch.
- Nuxt typecheck, workflow bundle verification, production build, and `git diff --check` pass.

## Safety

- No live publisher test, production access, migration deployment, commit, or push.
- Do not enable governor `enforce` in production as part of this task.
- Do not weaken SSRF, robots, or crawler identity controls.

## Completion response

Report the feed transition matrix, demotion threshold, 403 circuit threshold/cooldown matrix, source/category scope rules, shadow/enforce behavior, validation results, and any production configuration that still requires a controlled rollout.
