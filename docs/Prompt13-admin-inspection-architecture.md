# Prompt 13 — Admin inspection architecture

## Existing boundaries

Normal dashboard articles are loaded by `server/api/feed.ts`. It obtains the
authenticated user ID, reads only active `UserSourceSubscription` and
`UserCategorySubscription` rows, builds predicates with
`server/utils/subscription-scope.ts`, and applies the durable publication gate
from `server/utils/news-pipeline/publication-gate.ts`. Admin inspection does not
call this resolver and does not modify it.

Normal source/category filters are populated from `/api/user/sources`, which is
subscription-scoped and quota-aware. Prompt 13 uses separate inspection
endpoints so the existing filter cannot silently change meaning.

## Authorization

Every Prompt 13 endpoint resolves the session user ID (`requireUserId`, 401 if
missing) and delegates to framework-independent services in
`server/services/admin-inspection.ts`. Every service enforces
`requireInspectionAdminForUser`, which reads the user's current database email
and compares its normalized lower-case value with `NUXT_ADMIN_EMAILS`. A
database `ADMIN` role, client flag, request body, header, or query email is not
sufficient; authenticated users without a configured email return 403 and
responses never reveal configured email lists. The H3 wrapper
`requireInspectionAdmin` (session + database-email authority) is the same guard
used by the PostgreSQL application isolation integration test.

The legacy `requireAdminId` / bootstrap-admin behavior remains unchanged for
existing operational endpoints.

## Snapshot transport (production-safe)

All-active article inspection reuses the exact validated active-target universe
returned by source inspection via a signed snapshot token. The token is a JWT
signed with the server secret (`JWT_SECRET`, issuer/audience bound) carrying a
version, canonical active-target filter fingerprint, bounded active IDs,
truncation metadata, `generatedAt`, a 5-minute expiry, and an explicit content
hash. Malformed, expired, modified, wrong-target-type and wrong-filter tokens
are rejected with HTTP 400; tampered IDs are never trusted because the content
hash and signature are re-verified.

Transport is a read-only POST endpoint
(`/api/dev/admin-article-inspection`, `server/api/dev/admin-article-inspection.post.ts`):

- the snapshot token travels in a bounded JSON body, never in a GET query
  parameter, so proxies, browsers, Vercel routing and server request-line
  limits cannot reject it before application validation;
- maximum transport size: 64 KB body cap (HTTP 413) and a 64,000-character
  token cap enforced both at creation and at parse time;
- maximum supported universe: 500 source IDs + 500 category IDs (1,000 active
  IDs at the resolver caps). Worst-case UUID-shaped IDs at that count measure
  ~52.6 KB, inside both caps (regression-tested);
- expiry: 5 minutes, short enough that stale universes cannot outlive the
  inspection session; expired tokens are rejected with HTTP 400;
- authorization binding: the same `requireInspectionAdminForUser` authority and
  the same 30 req/min rate limit as every other inspection endpoint;
- truncation: `sourceTruncated`/`categoryTruncated`/`artifactEvidenceTruncated`
  are carried in the token and reported truthfully in the summary;
- explicit small target inspection stays on GET and never requires a snapshot;
  a snapshot supplied on GET is refused with HTTP 400;
- the token is never written to logs, diagnostics, error messages, browser
  history, referrer URLs, or analytics; validation errors are generic.

Without a supplied token, all-active GET/POST resolves a fresh snapshot and
reports `selection.snapshotSource: "independent"`; with a validated token it
reports `"client-provided"` and uses the exact IDs (no re-resolution).

## Canonical inspection-active definition

A logical source or category is inspection-active only when it has an active
subscriber, is marked as a durable system-imported target, has future deferred
work, or has actionable Agent 1/Agent 2 recovery evidence. A non-terminal RSS
status alone is not sufficient. `FAILED` and `DOMAIN_DEAD` are terminal and a
failed parent source makes its category inactive. The API exposes the bounded
reason (`ACTIVE_SUBSCRIBER`, `SYSTEM_TARGET`, `DEFERRED_RETRY`,
`ACTIVE_RECOVERY`, or `NONE`) without subscriber identities. All-active article
inspection uses the same definition as the source summary.

## Durable inspection states and evidence

Article inspection maps durable `Article.publicationStatus`,
`publicationStage`, `publicationReadyAt`, `enrichmentStatus`, and the canonical
publication gate into `PUBLISHED`, `PENDING`, `DEFERRED`,
`RETRYABLE_FAILURE`, `PERMANENT_FAILURE`, or `REJECTED`. The latest bounded
Agent 3 `PipelineArtifact` evidence is preferred for rejection, retry, deferred,
and browser-fallback details. Absence of an artifact is not treated as proof of
success.

Source/category summaries use bounded grouped article and artifact queries,
active subscriber counts, canonical RSS health fields, and centrally derived
 diagnostic flags. URLs have credentials, query strings, and fragments removed;
body text is not returned by list APIs; diagnostic strings are bounded. Article
body publication readiness is projected with a parameterized PostgreSQL
whitespace-trimmed length expression and a bounded prefix; complete body text
is never loaded by list/summary scans.

## Pagination and limits

Inspection uses deterministic ordering, cursor values, bounded limits (default
50, maximum 100), at most 25 explicitly selected article targets, and a maximum
90-day date window. Empty article selection is safe and returns no articles;
`allActive=true` is explicit and remains paginated.

## Isolation

Inspection is read-only. It does not create or update subscription rows, quota
state, notifications, pipeline decisions, or normal feed scope. The dashboard
mode is client-only state and is cleared on logout and authenticated user-ID
changes. Inspection APIs are authenticated server requests and are not exposed
through a public cache.

## Known operational limits

The current repository has no dedicated Vue component mounting harness, so the
initial UI coverage is contract/helper oriented. Authenticated desktop/mobile
browser verification still requires a safe local fixture/session handoff. No
Prisma schema or migration is required for this read-only feature.
