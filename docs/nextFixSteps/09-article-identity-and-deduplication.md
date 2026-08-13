# Repair 09: Article Identity and Deduplication Contract

## Objective

Define and enforce one explicit Article identity contract across RSS GUIDs, canonical URLs, HTTP/HTTPS variants, syndicated links, and content hashes without silently dropping unrelated articles or creating duplicates.

## Prerequisite

Complete Repair 08 first so corrupted decoding cannot create unstable titles, bodies, or content hashes.

## Scope

Primary areas:

- Prisma `Article` uniqueness/index definitions
- Agent 1 RSS/Atom GUID and link normalization
- Agent 2 candidate persistence
- Agent 3 canonical URL updates and HTTP-to-HTTPS provenance
- duplicate classification and bounded audit artifacts
- migrations and data compatibility analysis
- focused unit and localhost-only PostgreSQL integration tests

Do not change extraction quality, charset decoding, publication thresholds, feed productivity policy, 403 policy, or subscription behavior.

## Required design decision

Before editing schema, document the intended identity for each case:

- same canonical story rediscovered by the same source;
- HTTP and HTTPS variants of the same URL;
- tracking/query/AMP/mobile variants;
- the same syndicated wire story published by different source domains;
- an aggregator feed whose item links to an external publisher;
- duplicate or reused RSS GUIDs across sources;
- blank/missing GUID;
- identical valid body text across sources;
- identical boilerplate/error/interstitial body text.

Do not assume global or per-source uniqueness without proving product intent and existing data impact.

## Required behavior

1. `rssGuid` must never be treated as globally trustworthy unless scoped by verified feed/source provenance.
2. Canonical normalization must be deterministic, SSRF-safe where network resolution is involved, and shared across agents.
3. HTTP/HTTPS variants that represent the same article must converge without creating two rows, while original-link provenance remains available.
4. External syndicated links may remain valid Articles but must preserve collection-source versus destination-domain provenance.
5. `contentHash` must not allow boilerplate, access-denied, interstitial, empty, or short stub bodies to suppress unrelated articles.
6. Duplicate outcomes must be classified explicitly, for example same-source duplicate versus syndicated duplicate, rather than generic persistence failure.
7. Concurrent inserts must be resolved by database constraints plus deterministic conflict handling, not check-then-insert alone.
8. Existing bookmarks/read activity/ratings must not be orphaned by merge or migration behavior.
9. Feed queries must continue using explicit selects and must not pull wide body/outcome columns unnecessarily.

## Migration procedure

The current schema already contains `@@index([sourceId, date])` and
`@@index([categoryId, date])` on `Article`. Preserve and verify these indexes;
do not create duplicate FK indexes in this repair. Audit other relevant FK
indexes read-only, and only include a missing index in a forward migration when
the query/delete path and existing index set prove that it is necessary.

If schema changes are required:

1. audit current duplicate/conflict counts with read-only bounded queries;
2. design a forward-only migration;
3. document treatment of existing conflicting rows;
4. do not rewrite an applied migration;
5. add static SQL assertions and an opt-in localhost-only PostgreSQL execution test;
6. do not deploy the migration in this task.

## Tests

Cover:

- reused GUID across two sources;
- missing and malformed GUID;
- same-source HTTP/HTTPS identity;
- external destination collected through an aggregator source;
- same wire body on different publishers according to the chosen contract;
- boilerplate/access-denied hash collision does not suppress a valid article;
- concurrent duplicate inserts;
- Agent 3 canonical upgrade does not create a second row;
- provenance survives dedupe/merge;
- bookmarks/read activity remain attached;
- duplicate telemetry is truthful and bounded.

## Acceptance criteria

- The identity matrix is explicit and implemented consistently across Agents 1/2/3.
- Database constraints match the documented product decision.
- No unrelated article is silently dropped because of GUID or invalid body hash collision.
- HTTP/HTTPS and canonical variants cannot create duplicate Articles.
- Focused tests, Prisma validate/generate, localhost integration when applicable, Nuxt typecheck, and `git diff --check` pass.

## Safety and validation budget

- No production migration, data repair, commit, or push.
- Never print complete production URLs with sensitive queries or article bodies in audit output.
- Do not run the full suite repeatedly.

## Completion response

Report the final identity matrix, uniqueness constraints, migration files and deployment status, legacy conflict counts if safely inspected locally, duplicate classifications, integration evidence, and remaining ambiguity.
