# Prompt 17G - Robots Access Policy

## Authority and Boundaries

`server/utils/news-pipeline/robots-policy.ts` is the single robots parser,
cache, and URL-decision authority for Agent 1, Agent 2, Agent 3, and browser
main navigation.

- Robots policy decides whether a publisher URL may be requested.
- Domain Governor decides whether the domain may be requested now.
- SSRF guard decides whether the network target is safe.
- Prompt 16 access classification decides what returned article content means.

These decisions must not be merged. Robots policy is not an anti-bot bypass and
does not use browser navigation to retrieve `robots.txt`.

## Request Policy

- Robots is fetched only through `governedSafeFetchAndParse()` with the Domain
  Governor context and `purpose: "robots"`.
- The crawler identity is `NuSiftBot/1.0 (+https://nusift.app/bot)`.
- Parsed rules are evaluated using exact crawler groups before wildcard groups;
  the longest matching rule wins, with `Allow` winning equal-length ties.
- Only bounded parsed groups, directives, sitemap URLs, status, and timestamps
  are retained. Raw robots bodies, query strings, cookies, request headers,
  and response bodies are not persisted.
- A disallowed URL stops before static transport or browser navigation and is a
  neutral policy decision. It is not a paywall, publisher failure, hard-source
  failure, or browser-runtime failure.

## Unavailable-Robots Matrix

| Robots result | Policy decision | Follow-up request |
| --- | --- | --- |
| `200`, valid rules, allowed path | allowed | permitted through Governor and SSRF checks |
| `200`, valid rules, disallowed path | disallowed | no article, listing, sitemap, or browser request |
| `200`, empty rules | allowed, `no_policy` | permitted through Governor and SSRF checks |
| `200`, malformed content | deferred | no publisher follow-up request |
| oversized body | deferred | no publisher follow-up request |
| `404` | allowed, `no_policy` | permitted through Governor and SSRF checks |
| `403` | allowed, `forbidden` evidence | no browser request is used to retrieve robots |
| `429` | deferred, bounded `Retry-After` | Domain Governor circuit/cooldown applies; no browser fallback |
| timeout, network error, or `5xx` | allowed, `unavailable` evidence | permitted through normal Governor and SSRF checks; recheck is bounded |
| Governor denial or refresh lease conflict | deferred | no publisher follow-up request |

The chosen policy is fail-open only for unavailable/`403`/`404` robots results,
because those results do not prove a disallow rule. Malformed or oversized
content is fail-closed. An expired cache entry is never reused as an active
allow/deny decision after a failed refresh.

## Durable Cache and Concurrency

The forward-only migration
`20260811000000_add_publisher_robots_policy` creates the bounded
`PublisherRobotsPolicy` table. The canonical domain key follows Prompt 17B:
HTTP(S) hostname, lowercase ASCII form, terminal dot removed, and one leading
`www.` removed without collapsing subdomains to an eTLD+1.

- Normal cache lifetime: 24 hours maximum.
- Refresh ownership: bounded lease token and expiry.
- Cache write: version and lease-token CAS.
- Network fetch: outside any database transaction.
- Concurrent refreshes: one worker fetches; other workers receive a bounded
  deferred decision.
- A migration-not-yet-applied local/test process may use the same governed
  parser as a non-durable compatibility path. It must not claim a durable
  cache hit. Production enforce/shadow use requires the migration first.

## Integration Order

1. `robots-policy.ts` validates and evaluates the URL policy.
2. Domain Governor acquires the request permit and records the result.
3. SSRF guard validates each request and redirect hop.
4. The caller reads/parses the bounded response while the permit remains valid.
5. Agent-specific persistence and Prompt 16 classification run only after the
   request result is available.

Static Agent 1/2/3 requests pass through the governed static adapter. Agent 2
sitemap discovery consumes sitemap URLs returned by the shared policy; it does
not parse or fetch `robots.txt` independently. Browser main navigation checks
the shared policy before `page.goto()`.

## Operational Checks

Before enabling the new policy in a deployment:

1. Apply `20260811000000_add_publisher_robots_policy` with `npx prisma migrate deploy`.
2. Verify the migration is recorded and the `PublisherRobotsPolicy` table and
   two expiry indexes exist.
3. Start in shadow/off-compatible mode and inspect bounded policy decisions.
4. Confirm a valid publisher feed still follows the feed-first path; robots
   checks remain governed and do not create duplicate robots requests per fresh
   cache entry.
5. Confirm a disallowed fixture produces no static transport or browser
   navigation and no hard-source or success side effect.
6. Confirm a robots `429` records bounded retry evidence and defers subsequent
   same-domain work.

Publisher-specific feed registration remains data/configuration. Do not add
publisher URLs or exceptions to generic pipeline code. No production publisher
request or migration is performed by this document.

## Residual Risks

- The new cache concurrency path still needs the opt-in localhost PostgreSQL
  integration test before production rollout.
- Unit tests prove parser and CAS contracts; they do not prove behavior against
  every publisher’s robots dialect.
- Unavailable robots results are intentionally fail-open, so network outages
  do not become accidental publisher-wide denial. Monitoring should review
  repeated unavailable decisions.
