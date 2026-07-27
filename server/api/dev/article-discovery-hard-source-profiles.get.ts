import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import { normalizeHardSourceProfile } from "../../utils/news-pipeline/hard-source-profile";
import { isScopedCategoryFeed } from "../../utils/news-pipeline/ingest";
import { validateDiscoveryEvidence } from "../../utils/news-pipeline/types";
import { readBoundedNumber } from "../../utils/news-pipeline/parse-bounded-number";

const VALID_VIEWS = new Set(["active", "history", "all"]);

/**
 * GET /api/dev/article-discovery-hard-source-profiles
 *
 * Admin-only. Returns compact hard-source profile artifacts derived from
 * persisted PipelineArtifact rows. These profiles provide structured evidence
 * for targets where both static and browser discovery failed, enabling
 * future AI inspection or custom adapter generation.
 *
 * View filtering:
 * - active (default): excludes profiles resolved by Agent 1 scoped RSS and
 *   profiles whose category currently has an active scoped RSS feed.
 * - history: only returns profiles that have been resolved.
 * - all: returns everything (no filtering).
 *
 * No DB schema changes — uses existing PipelineArtifact model.
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  await assertRateLimit(event, "article-discovery-hard-source-profiles", 10, 60 * 1000);

  const query = getQuery(event);
  const limit = readBoundedNumber(query.limit, 50, 1, 200);
  const requestedView =
    typeof query.view === "string" && VALID_VIEWS.has(query.view)
      ? query.view
      : "active";

  const where: Record<string, unknown> = {
    artifactType: "article_discovery_hard_source_profile",
  };

  // View-based status filtering
  if (requestedView === "active") {
    where.status = { notIn: ["RESOLVED_BY_AGENT1_RSS"] };
  } else if (requestedView === "history") {
    where.status = "RESOLVED_BY_AGENT1_RSS";
  }
  // view=all: no status filter

  const artifacts = await prisma.pipelineArtifact.findMany({
    where,
    select: {
      id: true,
      sourceId: true,
      categoryId: true,
      createdAt: true,
      updatedAt: true,
      payload: true,
      status: true,
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  let profiles = artifacts.map(normalizeHardSourceProfile);

  // For active view: additionally filter out profiles whose category
  // currently has an active scoped RSS feed in the DB. This catches
  // categories that were resolved after the profile was created but
  // the profile artifact wasn't explicitly marked.
  if (requestedView === "active") {
    const categoryIds = [...new Set(
      artifacts
        .map((a) => a.categoryId)
        .filter((id): id is string => id !== null),
    )];

    if (categoryIds.length > 0) {
      const activeScopedCategories = await prisma.sourceCategory.findMany({
        where: {
          id: { in: categoryIds },
          rssStatus: "ACTIVE",
          rssFeedUrl: { not: null },
        },
        select: {
          id: true,
          pathUrl: true,
          rssFeedUrl: true,
          discoveryEvidence: true,
        },
      });

      const activeScopedCategoryIds = new Set<string>();
      for (const cat of activeScopedCategories) {
        const evidence = validateDiscoveryEvidence(cat.discoveryEvidence);
        if (isScopedCategoryFeed(cat.pathUrl, cat.rssFeedUrl, {
          scopeMatch: evidence?.scopeMatch,
          outcome: evidence ? { scopeMatch: evidence.scopeMatch } : undefined,
        })) {
          activeScopedCategoryIds.add(cat.id);
        }
      }

      if (activeScopedCategoryIds.size > 0) {
        const filteredIndices = artifacts
          .map((a, i) => a.categoryId && activeScopedCategoryIds.has(a.categoryId) ? i : -1)
          .filter((i) => i >= 0);
        const excludeSet = new Set(filteredIndices);
        profiles = profiles.filter((_, i) => !excludeSet.has(i));
      }
    }
  }

  return {
    ok: true,
    profiles,
    total: profiles.length,
    view: requestedView,
  };
});
