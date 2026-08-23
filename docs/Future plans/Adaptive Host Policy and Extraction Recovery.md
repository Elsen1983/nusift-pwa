# Future Plan: Adaptive Host Policy and Extraction Recovery

## Status

This is a future design and backlog document. It does not authorize runtime,
database, dependency, Docker, Vercel, or browser-policy changes by itself.

The work must be implemented in the NuSift TypeScript/Node codebase. Do not
import Scrapling, add a Python runtime, or create a parallel crawler stack.
The external project is design inspiration only.

## Objective

Improve Agent 1, Agent 2, and Agent 3 reliability for slow, rate-limited,
JavaScript-rendered, and layout-changing publishers while preserving:

- publisher-friendly access rules;
- durable claims, artifacts, retries, and cooldowns;
- the existing Agent 1 -> Agent 2 -> Agent 3 boundaries;
- canonical URL, body-quality, access classification, and publication gates;
- bounded evidence and redaction rules.

## Non-goals

Do not implement or enable:

- anti-bot, CAPTCHA, Turnstile, or Cloudflare bypass;
- stealth or browser-fingerprint spoofing;
- proxy rotation or third-party proxy providers;
- remote CDP connections, external browser-control endpoints, or MCP servers;
- persistent authenticated browser sessions or retained publisher cookies;
- automatic publication from browser network responses;
- unbounded HTML, JSON, browser traces, or credentials in artifacts or admin APIs.

## Design Principles

1. The durable database state remains authoritative. In-memory queue or host
   state may optimize selection but cannot prove success or terminal state.
2. A request is successful only after the Article and required durable artifact
   persistence have completed.
3. A host cooldown applies across all agents and browser fallback paths.
4. New recovery mechanisms begin in shadow or explicitly enabled fallback mode.
5. Every new decision must be observable with bounded, sanitized evidence.
6. Existing explicit `Retry-After` and publisher access restrictions take
   precedence over throughput objectives.

## Phase 1: Shared Host Request Policy

### Goal

Create one policy module used by Agent 1, Agent 2, and Agent 3 to interpret
host-level timing, retry eligibility, and cooldown outcomes consistently.

### Proposed module

`server/utils/news-pipeline/host-request-policy.ts`

### Inputs

- normalized hostname;
- response status and response latency;
- parsed `Retry-After` value;
- failure class: timeout, 403, 429, 5xx, network error, or interstitial;
- current durable host cooldown state;
- agent and operation mode.

### Outputs

- `nextEligibleAt`;
- `delayMs`;
- `cooldownReason`;
- retry classification;
- bounded policy evidence and telemetry fields.

### Required behavior

- Parse both numeric and HTTP-date `Retry-After` forms.
- Let explicit `Retry-After` take precedence over local adaptive timing.
- Treat HTTP 429 as a host cooldown, including browser fallback requests.
- Do not classify every HTTP 403 as rate limiting; retain the existing
  access-denied versus rate-limited evidence distinction.
- Gradually reduce learned delay only after healthy requests.
- Never let a healthy request bypass an active explicit cooldown.
- Keep the policy separate from Article publication and enrichment state.

### Acceptance criteria

- All three agents use the same parser and policy classification.
- A 429 from one agent prevents immediate same-host work in another agent.
- Other hosts remain eligible during a host cooldown.
- Numeric, HTTP-date, invalid, and missing `Retry-After` cases have tests.
- Policy artifacts are redacted and bounded.

## Phase 2: Host-Fair Prioritized Selection

### Goal

Prevent one noisy, blocked, or high-volume host from consuming a whole Agent 2
or Agent 3 batch.

### Priority order

1. New, never-attempted eligible work.
2. Ready retry work.
3. Browser-recovery-eligible work.
4. Deferred work whose host cooldown has expired.
5. Explicitly targeted and confirmed admin reprocess work.

### Required behavior

- Use host-fair selection, such as bounded round-robin or weighted fairness.
- Limit consecutive selections from the same host within a batch.
- Exclude cooldown-bound items from `retryableNow`.
- Preserve durable claim, lease, same-run exclusion, and terminal-state rules.
- Persist a bounded selection reason for selected and skipped work.

### Request identity

Define a stable request fingerprint from:

- normalized canonical URL;
- agent and operation mode;
- relevant extractor or policy version.

Do not include cookies, authorization headers, or raw secret-bearing query
values. Existing URL redaction rules remain mandatory for diagnostics.

### Acceptance criteria

- A noisy host cannot occupy more than the configured fair-share of a batch.
- Identical work cannot run twice in one orchestration without explicit
  reprocess semantics.
- Selection is deterministic for equivalent durable state.
- Queue telemetry distinguishes selected, skipped-for-cooldown, skipped-for-
  fairness, claimed, and persisted results.

## Phase 3: Redacted Response Replay

### Goal

Make Agent 1/2/3 network and extraction failures reproducible locally without
repeatedly requesting publisher pages.

### Design

- Add a Git-ignored local fixture store and explicit CLI tooling.
- Record only redacted request identity, selected headers, status, response
  hash, bounded payload or approved test snapshot, and expected outcome.
- Support Agent 2 discovery and Agent 3 extraction replay.
- Never write production data during replay.

### Required fixture cases

- HTTP 202 interstitial or challenge;
- 403 access block;
- 429 with `Retry-After`;
- empty or malformed HTML;
- JavaScript-rendered shell;
- valid JSON-LD article body;
- accessible article that discusses a paywall without being paywalled.

### Acceptance criteria

- Replays require no live publisher network request.
- Fixtures contain no cookies, credentials, secret query values, or unrestricted
  browser traces.
- A failed historical extraction can be reproduced from a fixture ID.
- Fixture storage is not committed by default.

## Phase 4: Controlled Browser XHR Capture

### Goal

Recover article text from same-origin structured browser responses when normal
DOM extraction and the existing browser fallback cannot find a usable body.

### Guardrails

- Feature flag default is disabled.
- Run only inside an already authorized Agent 3 browser fallback attempt.
- Consider only canonical-host or explicitly allowlisted first-party responses.
- Accept only structured content types with strict per-response and per-page
  size limits.
- Do not retain request bodies, cookies, authorization data, or third-party
  analytics payloads.
- Pass candidate text through the existing canonical, body-quality, access
  classification, paywall, and publication gates.
- Persist only bounded, sanitized evidence of why a response was selected or
  rejected.

### Acceptance criteria

- XHR capture cannot bypass source, host, cooldown, or browser budgets.
- XHR text cannot publish an Article directly.
- A capture failure does not suppress normal DOM extraction.
- Third-party, tracker, advertisement, and oversized responses are ignored.

## Phase 5: Selector Recovery in Shadow Mode

### Goal

Propose resilient extraction candidates after publisher layout changes without
allowing recommendation cards, navigation, ads, or other chrome to become
article body text.

### Design

- Store a structural fingerprint only after a confirmed high-quality extraction.
- Run selector recovery as a shadow candidate before it can affect outcomes.
- Require candidate output to pass existing body quality, canonical identity,
  access classification, and article-root checks.
- Version selector fingerprints and retain bounded success/failure evidence.
- Allow revocation when a profile produces low-quality or false-positive text.

### Acceptance criteria

- No automatic global selector trust.
- No publisher profile is promoted from one success alone.
- Shadow metrics report recovery gain and false-positive risk separately.
- Existing extraction remains authoritative until a measured promotion decision.

## Phase 6: Telemetry and Admin Diagnostics

### Required reporting

- host policy state, cooldown reason, and next eligible time;
- `Retry-After` source and parsed form;
- queue priority, selection reason, and fairness skips;
- replay fixture identifier and replay result;
- XHR capture attempted/accepted/rejected counts and bounded reason;
- selector-recovery shadow result, confidence, and version;
- browser, static, and recovered extraction outcomes shown separately.

### Reporting invariant

Do not report work as successful from selection, fetch, or extraction alone.
Success requires the durable Article and artifact persistence result.

## Rollout Order

1. Shared host request policy.
2. Host-fair prioritized selection.
3. Response replay framework.
4. XHR capture in shadow mode.
5. Selector recovery in shadow mode.
6. Per-feature measured rollout behind feature flags.

## Promotion Gate

Promote a feature from shadow or optional fallback only when it:

- does not increase 403 or 429 rates;
- does not increase false body extraction or false paywall classification;
- measurably improves high-quality Agent 3 extraction success;
- stays within browser runtime, memory, and workflow-duration budgets;
- has durable artifacts and admin diagnostics sufficient for investigation;
- passes repeated-run, retry, cooldown, claim-loss, and persistence-failure
  integration tests.

## Preconditions for Any Implementation

- Review the current Agent 1/2/3 contracts before writing code.
- Confirm the current durable cooldown and queue schemas are sufficient before
  adding fields or migrations.
- Preserve the existing production browser safety policy.
- Implement one phase at a time; do not combine queue, browser, and extraction
  behavior changes in one rollout.
