# Prompt 17B - Persistent Domain Governor Foundation

## Objective

Create a PostgreSQL-backed Domain Request Governor that can coordinate Agent 1, Agent 2, Agent 3, and browser navigation across concurrent Vercel Function instances.

This prompt creates the durable model and tested service in `off`/`shadow` mode. It must not yet change whether any existing network request is executed.

## Scope

Expected files:

- `prisma/schema.prisma`
- one new forward migration
- a focused module such as `server/utils/news-pipeline/domain-request-governor.ts`
- focused unit tests
- an opt-in localhost-only PostgreSQL integration test
- minimal configuration/runtime parsing

Do not integrate the governor into Agent 1/2/3 call sites in this prompt.

## Durable model

Add a dedicated durable state keyed by normalized hostname or an equally explicit stable domain key. At minimum preserve:

- normalized domain key;
- circuit state: `CLOSED`, `OPEN`, or `HALF_OPEN`;
- cooldown deadline;
- next request deadline;
- active lease token and lease expiry;
- monotonically changing version or equivalent CAS field;
- consecutive 429 count;
- consecutive relevant 403 count;
- last HTTP status;
- last success timestamp;
- last blocked timestamp;
- timestamps required for audit and stale-lease recovery.

Use an enum only if it does not create migration/deployment ambiguity. Keep all indexes explicit and bounded to actual lookup paths.

Do not store full URLs, query strings, response bodies, cookies, headers, article text, or user data in this table.

## Domain-key normalization

Define and test one canonical normalization function:

- parse with WHATWG `URL`;
- allow only HTTP(S);
- use the ASCII lowercase hostname;
- remove a terminal dot;
- handle `www` consistently and document the choice;
- reject malformed hosts and IPs that the existing SSRF policy rejects;
- do not implement an unsafe hand-written public-suffix parser.

If related subdomains need a shared policy later, expose an explicit configured policy key instead of guessing eTLD+1.

## Governor API

Provide narrow APIs equivalent to:

```text
acquireDomainPermit(input) -> decision + optional lease token
recordDomainOutcome(input) -> persisted state transition
releaseDomainPermit(input) -> token-validated release
recoverExpiredDomainLeases(now) -> bounded recovery summary
```

The exact names may follow repository conventions.

The acquisition result must distinguish at least:

- allowed;
- shadow-would-allow;
- shadow-would-defer;
- circuit open;
- minimum interval not reached;
- active lease held;
- half-open probe unavailable;
- governor persistence unavailable.

## Concurrency and transaction requirements

- Acquisition must be atomic across two independent Prisma clients.
- At most one enforce-mode lease may be granted for a domain at a time.
- A half-open circuit may grant at most one probe lease.
- Lease completion and release must validate the token.
- A stale worker must not release or overwrite a newer lease.
- Expired leases must be recoverable without manual DB edits.
- Never hold a transaction, row lock, or advisory lock during network I/O or sleep.
- A process crash must leave only a bounded lease that expires.
- Use wall-clock timestamps for lease validity.

## Circuit policy foundation

Implement policy as pure/testable functions:

- 429 opens the circuit immediately;
- valid `Retry-After` is bounded by the existing maintained limits;
- missing/malformed `Retry-After` uses the existing fallback baseline;
- repeated 429 may extend cooldown within a hard maximum;
- a successful half-open probe closes the circuit and resets the 429 streak;
- another half-open 429 reopens the circuit;
- 403 is recorded but must not automatically be treated as 429;
- timeouts/5xx/network failures must not be mislabeled as publisher rate limits.

Do not duplicate Prompt 16 access classification in this module.

## Modes and failure policy

Support explicit `off`, `shadow`, and `enforce` modes.

- `off`: no governor DB activity.
- `shadow`: calculate and persist bounded decisions, but never suppress existing network work.
- `enforce`: return durable defer decisions.

The default for this prompt must be `off` or `shadow`, never enforce.

In enforce mode, governor persistence failure must fail closed for pipeline network work by returning a retryable/deferred decision. It must not silently issue an ungoverned request burst.

## Tests

Unit tests must cover normalization, every decision reason, state transitions, Retry-After bounding, token mismatch, expiry, half-open behavior, and malformed inputs.

Add an opt-in PostgreSQL test that:

- accepts only a PostgreSQL URL on localhost, `127.0.0.1`, or `[::1]`;
- requires an explicit environment opt-in;
- uses a randomized isolated schema;
- uses two independent Prisma clients and pools;
- proves only one concurrent lease winner;
- proves stale-token rejection and expired-lease recovery;
- cleans up in `finally`;
- never falls back to a remote database.

## Acceptance criteria

- Schema and migration are forward-only and consistent.
- The service is production-code complete but not connected to outbound traffic.
- Real PostgreSQL concurrency is either explicitly run and reported or safely skipped and reported as unverified.
- Prisma validate/generate, focused tests, full Vitest, Nuxt typecheck, production build, and `git diff --check` pass.

## Safety

- Do not run `prisma migrate deploy` against production.
- Do not edit `_prisma_migrations`.
- Do not modify existing migrations.
- Do not commit or push.

## Completion response

Separate implemented, unit/mock verified, PostgreSQL verified, migration-created, migration-deployed, and residual-risk status.
