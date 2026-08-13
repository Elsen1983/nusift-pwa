# Repair 13: Agent 2 Known-URL Prefilter and Conditional HTTP Memory

## Objective

Reduce repeated Agent 2 detail downloads and unchanged static fetches by using batched known-identity prefiltering and bounded conditional-request memory.

## Prerequisites

- Repair 09 must define canonical identity before URL prefiltering becomes authoritative.
- Repair 12 must land first so newly discovered embedded candidates enter the same prefilter path.

## Verified baseline

- Agent 1 already performs batched GUID/URL matching for feed items. Preserve it.
- Agent 2 currently performs detail evaluation before its final canonical duplicate check, so known URLs can consume most of the detail request budget repeatedly.
- No shared ETag/Last-Modified response-memory authority is currently used by the Agent 1/2/3 static transport.

## Scope

Primary areas:

- Agent 2 merged-link prefilter before article-detail requests
- shared normalized identity batching
- bounded HTTP validator/parsed-result memory for selected static resources
- governed-fetch conditional headers and 304 handling
- request-savings telemetry and focused tests

Do not change extraction rules, browser lifecycle, robots/governor decisions, Article uniqueness constraints, feed-productivity thresholds, or publication behavior.

## Known-URL prefilter

1. Normalize the bounded merged link set using the Repair 09 identity authority.
2. Query known Article/candidate identities in bounded batches before detail evaluation.
3. Skip a detail request only when the stored identity proves the same article under the chosen source/syndication contract.
4. Unknown, ambiguous, redirect-dependent, or weak identities must still be evaluated.
5. Preserve source/category provenance and distinguish `known_article_prefiltered` from duplicate persistence conflicts.
6. Prefiltering must not consume logical publisher request budget.
7. Avoid unbounded `IN` lists and N+1 database queries.

## Conditional HTTP memory

1. Define which resource classes may use validators: feeds, listing pages, robots policy integration points, sitemaps, or article details.
2. Persist only bounded validator metadata and the minimum parsed result needed to handle 304 truthfully. Do not persist raw unbounded HTML/XML.
3. Send `If-None-Match`/`If-Modified-Since` only for the same normalized resource identity and compatible request purpose.
4. A 304 is success only when a still-valid cached parsed result exists. Otherwise retry once without validators within the same request budget or return a truthful cache miss.
5. Redirect hops, SSRF, robots, and Domain Governor checks still apply independently.
6. 403/429/5xx/timeout must not overwrite a previously valid validator entry as successful content.
7. Use bounded TTL, payload size, pagination, and optimistic/CAS writes.
8. Record actual requests saved separately from shadow/estimated savings.

## Tests

Cover:

- all known Agent 2 links produce zero detail requests;
- mixed known/unknown links fetch only unknown identities;
- ambiguous canonical identity is not skipped;
- source/category and external syndication scope remains correct;
- exact batch/query bounds;
- ETag and Last-Modified request headers;
- valid 304 reuses bounded parsed output;
- 304 without usable cache retries/fails truthfully;
- changed 200 replaces validators only after durable parsed-result persistence;
- 403/429/timeout/persistence failure preserve truthful cache state;
- redirect target identity does not poison origin cache;
- request-budget and governor accounting remain exact.

## Acceptance criteria

- Known URLs no longer consume Agent 2 detail request slots.
- Conditional requests never produce false content success.
- Cache/identity state is durable, bounded, concurrency-safe, and Vercel-compatible.
- Existing Agent 1 dedupe remains unchanged.
- Focused tests, Prisma validate/generate if schema changes, Nuxt typecheck, production build if dependencies change, and `git diff --check` pass.

## Safety and validation budget

- Prefer a forward-only schema migration only after documenting why existing bounded artifacts cannot safely store validator state.
- No production migration, publisher call, commit, or push.
- Do not repeatedly run the full suite.

## Completion response

Report identity/query batching, resource cache matrix, TTL and size bounds, 304 fallback semantics, request savings proven by tests, migration status, and unsupported cache cases.
