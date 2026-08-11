# Prompt 17H - Governance Observability and Admin Diagnostics

## Scope

This feature is read-only observability. It does not change the Domain Governor, robots policy, SSRF checks, Agent 1/2/3 request decisions, article access classification, publication, or user feed behavior.

The admin endpoint is:

```text
GET /api/dev/domain-governance
```

It uses the existing `requireAdminId` authorization and rate-limit pattern. It is not a public API and has no mutation controls.

## Evidence authority

- `DomainRequestGovernor` is authoritative for the current normalized domain key, circuit state, cooldown/next-request time, latest decision, HTTP status, streaks, and lease expiry. Lease tokens are never returned.
- `PublisherRobotsPolicy` is authoritative for the bounded cached robots status, freshness, HTTP status, and last decision. Parsed rules and raw robots content are never returned.
- `stage_batch_telemetry` artifacts are authoritative for persisted batch-level actual-work counters: network requests, browser attempts, 403/429 observations, timeouts, and persisted success buckets. They are grouped by stage and inferred transport (`agent2-headless` is browser; the other stages are static).
- Final enrichment/discovery artifacts are the source for bounded per-outcome browser evidence. Claim-lost and failed-persistence outcomes are not treated as persisted success outcomes.

The response marks evidence as `complete`, `bounded`, or `unavailable`. A bounded or unavailable field must not be interpreted as an exact historical total.

## Diagnostic fields

The canonical `NetworkAttemptOutcome` contains only:

- normalized domain key;
- agent/stage, bounded purpose, and static/browser transport;
- governor mode, decision, reason, and circuit fields when they were persisted;
- HTTP status, bounded Retry-After source/deadline;
- lease acquired/released/expired facts when available;
- browser main-document, first-party, and third-party request counts;
- bounded duration and duration bucket;
- persisted outcome classification and evidence coverage.

Counters are persistence-aware. Stage disposition counters are read only from durable telemetry artifacts, while actual-work counters remain explicitly separate. The endpoint does not add a second success/failure channel and does not alter Prompt 16 access counters.

## Pagination and bounds

- Domain rows use deterministic `domainKey ASC` cursor pagination.
- Default domain page size is 25; maximum is 100.
- Artifact evidence uses a bounded scan cap of 500 rows and newest-first deterministic ordering.
- `pagination.truncated` and `evidence.truncated` are returned when a cap is reached.
- Diagnostic text is bounded and all unknown/malformed legacy payloads are ignored or marked unavailable.

## Redaction contract

The response never exposes complete URLs, query strings, IP addresses, headers, cookies, credentials, authorization values, raw robots files, HTML, article text, browser storage, provider response bodies, challenge tokens, or user identifiers. Existing payloads may contain legacy URL/body fields, but the service reads only whitelisted diagnostic fields and does not return those values.

## Interpretation

- `domains[].circuitState` answers the current `OPEN`, `HALF_OPEN`, or `CLOSED` state question.
- `domains[].circuitReason` and `nextProbeAt` explain the current durable decision where available.
- `domains[].lease.state` is `active`, `expired`, or `none`; expired leases are displayed, not recovered by this endpoint.
- `network.stageTransport` reports durable batch counters by stage and transport.
- `network.shadowWouldDefer` counts bounded persisted shadow decisions found in scanned evidence; `currentShadowWouldDeferDomains` reports the current-page domain-state diagnostic. Neither is a count of actual deferred requests.
- `network.browserAmplification` is available only where persisted browser navigation evidence exists.
- `network.policySkips` reports recognized feed-first and robots-denied/deferred evidence; missing legacy evidence is not inferred as a skip.

## Validation and deployment

This change requires no Prisma schema or migration change. Run the focused governance observability and endpoint suites, then Nuxt typecheck, workflow bundle verification, production build, and `git diff --check`. No production migration, request, or smoke test is part of this feature.

Known limitation: the pre-17H stage telemetry schema has no per-request domain, purpose, lease, or circuit-before/after history. Those dimensions are therefore reported as unavailable unless present in a bounded final outcome artifact; adding historical per-request persistence would require a separately reviewed forward migration and runtime telemetry change.
