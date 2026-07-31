-- Corrective safety net for databases that applied an earlier publication-gate
-- backfill before its whitespace and body-quality predicates were hardened.
UPDATE "Article"
SET
  "publicationStatus" = 'CANDIDATE',
  "publicationStage" = NULL,
  "publicationReadyAt" = NULL
WHERE "publicationStatus" = 'PUBLISHED'
  AND NOT (
    "enrichmentStatus" = 'ENRICHED'
    AND "title" IS NOT NULL
    AND regexp_replace("title", '[[:space:]]', '', 'g') <> ''
    AND "canonicalUrl" IS NOT NULL
    AND regexp_replace("canonicalUrl", '[[:space:]]', '', 'g') <> ''
    AND "bodyText" IS NOT NULL
    AND length(regexp_replace("bodyText", '^[[:space:]]+|[[:space:]]+$', '', 'g')) >= 500
  );
