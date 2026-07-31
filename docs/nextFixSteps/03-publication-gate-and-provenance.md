# Step 3: Add a publication gate and correct provenance

## Problem

The current feed boundary exposes `Article` rows directly, which means incomplete or not-yet-validated content can appear in the user feed.

The provenance fallback also writes `feedOrigin: "rss"` when the origin is not actually proven. That is a semantic lie, even if it is intended as a conservative default.

## What must change

1. Add an explicit publication state or publishable flag.
2. Filter the user feed to return only publishable articles.
3. Keep candidate and failure rows visible in admin diagnostics, not in the user feed.
4. Replace false provenance defaults with an explicit unknown or nullable origin.

## Recommended publication policy

Minimum-change option:

- add `publicationStatus` to `Article`;
- treat only one state as user-visible, such as `PUBLISHED`.

Preferred long-term option:

- split candidates from published articles;
- promote rows only after the validation contract is satisfied.

## Provenance rules

- do not infer RSS origin from the mere existence of an article row;
- do not infer Agent 1 origin from `categoryId` alone;
- store stable references to the producing artifact or pipeline run when known;
- allow unknown origin explicitly instead of guessing.

## Tests to add or update

- unpublished rows do not appear in the feed;
- failed or incomplete enrichment rows do not appear in the feed;
- provenance remains unknown when the origin cannot be proven;
- the feed still returns all valid published rows after the filter is enabled.

<!-- Prompt -->
You are working in the NuSift repository.

Task:
Add a publication gate for the user feed and correct provenance handling so unknown origin is not written as a false fact.

Context:
The current feed can expose Article rows directly, including incomplete or not-yet-publishable content. Provenance fallback logic may also assert `feedOrigin: "rss"` when the origin is not actually proven.

Your job:
1. Inspect the actual feed and provenance code, especially:
   - `server/api/feed.ts`
   - `server/utils/news-pipeline/enrichment-runtime.ts`
   - `server/utils/news-pipeline/enrichment-persist.ts`
   - `prisma/schema.prisma`
2. Determine the real publication boundary in the repo.
3. Implement an explicit publication policy so the user feed returns only publishable articles.
4. Keep candidates and failures visible to admin/diagnostic flows, but exclude them from the user feed.
5. Replace false provenance defaults with explicit unknown/nullable origin where the origin cannot be proven.
6. If the code can recover origin from artifacts or pipeline runs, store stable references instead of guessing.
7. Add tests to prove:
   - unpublished or incomplete rows do not appear in the feed
   - provenance does not claim RSS origin without evidence
   - published rows still appear correctly

Rules:
- Distinguish confirmed origin from inferred origin.
- Do not introduce a feed filter without deciding how legacy rows are handled.
- Be explicit if a migration/backfill is required.

Output required:
- the publication rule you implemented
- the provenance rule you implemented
- files changed
- tests added or updated
- any migration/backfill needed