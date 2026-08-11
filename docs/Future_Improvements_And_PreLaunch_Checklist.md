# NuSift Future Improvements and Pre-Launch Checklist

## Purpose

This document separates work that is intentionally deferred until after the MVP from checks that must be completed before a public launch. It is a planning authority, not evidence that an item has been implemented or verified.

The current Agent 1/2/3 persistence, claim/CAS, publication-gate, domain-governance, robots-policy, and feed-first foundations remain authoritative. Deferred work must preserve those contracts and must not be combined into a single large refactor.

## Status vocabulary

- `DEFERRED`: useful after the MVP; not a launch blocker by itself.
- `PRE_LAUNCH`: must be resolved, measured, or explicitly accepted before public release.
- `DECISION_REQUIRED`: product or operational policy must be chosen before implementation.
- `VERIFIED`: supported by current code, tests, and operational evidence.

## Deferred improvements

### 1. Admin dashboard decomposition

**Status:** `DEFERRED`

Split `app/pages/audit/admin.vue` into a route shell, panel components, and panel-specific composables. Lazy-load expensive panels where practical.

Acceptance criteria:

- Existing admin authorization remains unchanged.
- Read-only and mutating controls retain their current CSRF and confirmation behavior.
- Desktop and mobile browser verification covers every extracted panel.
- No panel loads an unbounded dataset or duplicates an existing API request.

### 2. Pipeline module decomposition

**Status:** `DEFERRED`

Refactor large Agent 1/2/3 modules one at a time along existing policy, transport, extraction, persistence, telemetry, and orchestration boundaries.

Acceptance criteria:

- No cross-stage state transition or persistence ordering changes during a mechanical extraction.
- Existing public exports remain compatible or are migrated atomically.
- Focused tests move with the extracted behavior.
- Claim loss, CAS conflict, retry, cooldown, and publication semantics remain unchanged.

### 3. Feed summary and article detail API separation

**Status:** `DEFERRED`

The user-feed query currently selects article body and enrichment metadata because the reader opens from the same response. Consider a bounded summary endpoint and a separate authorized article-detail endpoint.

Acceptance criteria:

- Feed cards do not fetch `bodyText`, full reasoning, or enrichment JSON.
- The reader fetches one authorized article on demand.
- Subscription scope and publication-gate checks are identical on both endpoints.
- Loading, retry, offline, and deleted-article states are handled in the UI.

### 4. Token-version cache

**Status:** `DEFERRED`

Evaluate a short-lived Redis cache for `userId -> tokenVersion` to reduce the database read performed by the global session guard.

Acceptance criteria:

- Password reset and account-security actions invalidate the cache.
- Cache failure falls back to the database and never authorizes an unknown session.
- TTL and bounded-staleness behavior are documented.
- Production latency evidence demonstrates a material benefit.

### 5. Database connection strategy

**Status:** `DEFERRED`, `DECISION_REQUIRED`

Do not increase `DATABASE_POOL_MAX` without measurements. Evaluate a managed pooler, Prisma Accelerate, or separate application and pipeline connection policies.

Acceptance criteria:

- Load testing includes simultaneous user-feed, authentication, and pipeline traffic.
- Connection counts remain below provider limits during scale-out.
- Pipeline work cannot starve interactive requests.
- Failure and reconnect behavior are observable.

### 6. Deduplication reason telemetry

**Status:** `DEFERRED`

Preserve the current global canonical/RSS GUID/content-hash identity until the product policy is explicitly changed. Add bounded duplicate classifications before changing uniqueness constraints.

Suggested classifications:

- `duplicate_rss_guid`
- `duplicate_canonical_url`
- `duplicate_transport_variant`
- `duplicate_content_hash`
- `duplicate_syndicated`

Acceptance criteria:

- Duplicate reasons are persistence-aware and do not inflate failures.
- HTTP and HTTPS variants remain one Article identity.
- Boilerplate or short-body hash collisions are measurable.
- Any move to per-source copies has a forward migration and feed behavior specification.

### 7. CSP nonce migration

**Status:** `DEFERRED`, promoted to `PRE_LAUNCH` if untrusted inline script rendering is introduced

Replace production `script-src 'unsafe-inline'` with a nonce- or hash-based policy only after Nuxt hydration, Google sign-in, and Apple sign-in are verified under the stricter policy.

Acceptance criteria:

- No blanket script `unsafe-inline` remains in production.
- Nuxt SSR/hydration and supported identity providers work without console CSP violations.
- Article rendering cannot introduce executable markup.
- CSP reporting is bounded and contains no sensitive payloads.

### 8. Assets, PWA precache, fonts, and locales

**Status:** `DEFERRED`

- Compress the default avatars and logos.
- Audit whether avatar collections are included in the PWA precache.
- Evaluate self-hosted fonts.
- Remove or complete locale entries that expose untranslated keys.

Acceptance criteria:

- A 200x200 default avatar is appropriately compressed.
- The precache manifest has a measured size budget.
- Font loading does not depend on an unnecessary third-party request.
- Every enabled locale passes a translation-key completeness check.

### 9. Documentation and dead-code cleanup

**Status:** `DEFERRED`

Archive superseded prompt/remediation documents, remove confirmed dead pages such as `index_old.vue`, and decide whether the repository needs an explicit license.

Acceptance criteria:

- Current architecture documents are clearly distinguished from historical plans.
- No deleted page or module has a runtime import, route, or generated reference.
- Git history remains the recovery mechanism for removed dead code.

## Pre-launch verification gates

### 1. Vercel function bundle size

**Status:** `PRE_LAUNCH`

Measure the actual generated size of every function that can include `playwright-core`, `chromium-bidi`, or `@sparticuz/chromium`. The workflow bundle guard proves known import invariants but does not prove provider size limits.

Required evidence:

- Production-equivalent Vercel build output.
- Per-function compressed and uncompressed sizes.
- Confirmation that browser dependencies are isolated from durable workflow bundles.
- Controlled runtime launch result or an explicitly documented Docker-only policy.

### 2. Production database concurrency and pool behavior

**Status:** `PRE_LAUNCH`

Run controlled load tests against a staging environment with production-equivalent connection limits.

Required evidence:

- Authentication and feed latency under concurrent pipeline work.
- Peak connection count and timeout rate.
- No user-facing starvation from Agent 1/2/3 batches.
- Documented rollback for any pool-size change.

### 3. PWA asset and cache budget

**Status:** `PRE_LAUNCH`

Inspect the generated Workbox precache rather than relying only on source glob assumptions.

Required evidence:

- Total precache bytes and entry count.
- Confirmation that optional avatar collections are not eagerly cached.
- Offline navigation and update behavior verified on desktop and mobile.

### 4. Locale readiness

**Status:** `PRE_LAUNCH`

Every advertised locale must either be complete or disabled.

Required evidence:

- Automated missing-key report against the English authority file.
- Browser verification of public, onboarding, dashboard, settings, and error states.
- Locale-prefixed route guards behave identically to default-locale routes.

### 5. Article identity and syndicated-content policy

**Status:** `PRE_LAUNCH`, `DECISION_REQUIRED`

Decide whether one canonical story remains a global Article or whether each publisher receives a separate record.

Required evidence:

- Collision report for `canonicalUrl`, `rssGuid`, and `contentHash` decisions.
- Product decision for syndicated and external-domain articles.
- Dashboard attribution remains truthful for external canonical domains.
- Duplicate outcomes are visible without being counted as pipeline failures.

### 6. Security browser verification

**Status:** `PRE_LAUNCH`

Verify production-equivalent CSP, OAuth, session expiry/revocation, CSRF, clickjacking protection, and dotted-route handling.

Required evidence:

- No protected route bypass through aliases, locale prefixes, or dotted paths.
- Google and Apple sign-in work under the deployed CSP.
- `frame-ancestors 'none'` and `X-Frame-Options: DENY` are present.
- Internal runner endpoints reject missing, malformed, and incorrect secrets.

### 7. End-to-end Agent 1 -> Agent 2 -> Agent 3 validation

**Status:** `PRE_LAUNCH`

Run a controlled staging pipeline using publisher-safe fixtures or explicitly approved targets.

Required evidence:

- Feed-first targets skip duplicate Agent 2 work.
- 429 responses defer without browser escalation.
- Robots denial performs no article or browser request.
- Claim/CAS loss creates no false success.
- Publishable articles reach the user feed and malformed articles do not.

## Execution rule

Pre-launch gates require recorded evidence, not an implementation summary. Deferred refactors should be scheduled as independent batches after MVP functionality is stable, with focused tests first and full validation only at the batch boundary.
