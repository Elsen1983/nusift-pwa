# Article Identity and Deduplication

## Authority

`server/utils/news-pipeline/article-identity.ts` is the shared deterministic
Article identity authority. It performs no network request and does not replace
SSRF, redirect, robots, or Domain Governor checks.

## Identity matrix

| Case | Identity decision | Durable behavior |
| --- | --- | --- |
| Same canonical story, same source | Same global canonical identity | Existing Article wins; category/tags may be enriched. |
| HTTP and HTTPS variants | Same global canonical identity | One Article; original transport remains in ingest/enrichment provenance. |
| Tracking parameters and query order | Known tracking keys removed; remaining keys sorted | One Article when the destination identity matches. |
| AMP/mobile variant | Distinct unless publisher canonical evidence resolves both to one URL | No heuristic path merge. |
| Same wire body on different publisher domains | Distinct canonical identities | Both Articles are stored even when `contentHash` is identical. |
| Aggregator item linking externally | Destination canonical is global identity; configured `sourceId` remains collection source | External destination provenance remains visible without changing subscriptions. |
| Reused RSS GUID across sources | GUID is scoped by `sourceId` | Both sources may store their own Article. |
| Missing, blank, control-character, placeholder, or oversized GUID | No GUID identity | Canonical identity remains authoritative. |
| Identical valid body text | Never an exclusion key | `contentHash` is diagnostic/indexed evidence only. |
| Identical boilerplate, blocked, interstitial, empty, or short body | Never an exclusion key | Cannot suppress an unrelated Article. |

## Database contract

- `canonicalUrl` preserves the chosen destination URL and remains globally
  unique for exact duplicates.
- `canonicalIdentity` is nullable and globally unique for deterministic URL
  variants.
- `@@unique([sourceId, rssGuid])` scopes opaque GUID trust to one source.
- `contentHash` is non-unique and indexed only.
- Existing Article IDs are never merged by the migration, so bookmarks,
  ratings, read activity, and enrichment claims stay attached.

Legacy canonical conflicts are not deleted or merged. Migration backfill leaves
`canonicalIdentity` null for every ambiguous conflict group; operators must
review those rows before any later repair.

## Deployment order

1. Run the bounded conflict audit without printing URLs or bodies.
2. Back up the target database and confirm rollback readiness.
3. Apply `20260812160000_define_article_identity_contract` before application
   code that reads or writes `canonicalIdentity` is deployed.
4. Confirm the three replacement indexes exist and migration status is current.
5. Deploy application code and verify one controlled HTTP/HTTPS replay is
   classified as a duplicate rather than inserted twice.

This task creates the forward migration but does not deploy it.

## Index audit

The existing `Article(sourceId, date)` and `Article(categoryId, date)` indexes
already cover source/category feed filtering and FK delete checks. Existing
PipelineArtifact source/category indexes and Notification/PushSubscription user
indexes were retained; no duplicate FK index is introduced here. User-feed
queries continue to use explicit selects and do not load `enrichmentOutcome` or
`reasoning` unless a detail/inspection path explicitly requests them.
