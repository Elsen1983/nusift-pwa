ALTER TABLE "Article"
ADD COLUMN "canonicalIdentity" TEXT;

-- Existing pipeline URLs were already stripped of fragments, known tracking
-- keys, and trailing slashes. Backfill transport equivalence without merging
-- any ambiguous group; conflicting legacy rows remain explicit NULLs.
WITH url_parts AS (
  SELECT
    "id",
    regexp_replace(split_part("canonicalUrl", '#', 1), '^http://', 'https://', 'i') AS without_fragment
  FROM "Article"
  WHERE "canonicalUrl" IS NOT NULL
), normalized AS (
  SELECT
    "id",
    split_part(without_fragment, '?', 1) ||
      CASE WHEN position('?' IN without_fragment) = 0 THEN '' ELSE
        COALESCE((
          SELECT '?' || string_agg(parameter, '&' ORDER BY parameter)
          FROM regexp_split_to_table(split_part(without_fragment, '?', 2), '&') parameter
          WHERE lower(split_part(parameter, '=', 1)) NOT IN (
            'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'utm_campaign',
            'utm_content', 'utm_medium', 'utm_source', 'utm_term'
          )
        ), '')
      END AS identity
  FROM url_parts
), unambiguous AS (
  SELECT identity
  FROM normalized
  GROUP BY identity
  HAVING count(*) = 1
)
UPDATE "Article" article
SET "canonicalIdentity" = normalized.identity
FROM normalized
JOIN unambiguous USING (identity)
WHERE article."id" = normalized."id";

DROP INDEX "Article_rssGuid_key";
DROP INDEX "Article_contentHash_key";

CREATE UNIQUE INDEX "Article_canonicalIdentity_key"
ON "Article"("canonicalIdentity");

CREATE UNIQUE INDEX "Article_sourceId_rssGuid_key"
ON "Article"("sourceId", "rssGuid");

CREATE INDEX "Article_contentHash_idx"
ON "Article"("contentHash");
