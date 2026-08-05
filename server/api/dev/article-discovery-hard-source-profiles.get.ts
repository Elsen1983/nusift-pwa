import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import {
  aggregateHardSourceProfiles,
  filterActiveHardSourceRows,
  filterResolvedHardSourceRows,
  type HardSourceProfileRawRow,
} from "../../utils/news-pipeline/hard-source-profile";
import { isScopedCategoryFeed } from "../../utils/news-pipeline/ingest";
import { validateDiscoveryEvidence } from "../../utils/news-pipeline/types";
import { readBoundedNumber } from "../../utils/news-pipeline/parse-bounded-number";

const VALID_VIEWS = new Set(["active", "history", "all"]);
/** A page is deliberately bounded; the final limit is applied after grouping. */
const RAW_PAGE_SIZE = 1_000;
/** Hard safety bound: no request can scan more than five bounded pages. */
const RAW_SCAN_CAP = 5_000;
const MAX_SCAN_PAGES = Math.ceil(RAW_SCAN_CAP / RAW_PAGE_SIZE);

type ScanCursor = { updatedAt: Date; id: string };
type ScanStopReason = "exhausted" | "requested_limit_satisfied" | "scan_cap_reached" | "max_pages_reached";

type HardSourceScanResult = {
  artifacts: HardSourceProfileRawRow[];
  scannedRows: number;
  scannedPages: number;
  scanCapReached: boolean;
  exhausted: boolean;
  stopReason: ScanStopReason;
  postFilterLogicalTargets: number;
};

async function scanHardSourceArtifacts(
  requestedLimit: number,
  requestedView: string,
): Promise<HardSourceScanResult> {
  const artifacts: HardSourceProfileRawRow[] = [];
  let cursor: ScanCursor | null = null;
  let scannedPages = 0;
  let exhausted = false;
  let stopReason: ScanStopReason = "max_pages_reached";
  let postFilterLogicalTargets = 0;

  while (scannedPages < MAX_SCAN_PAGES && artifacts.length < RAW_SCAN_CAP) {
    const where: Record<string, unknown> = {
      artifactType: "article_discovery_hard_source_profile",
    };
    // Pure explicit keyset pagination over (updatedAt DESC, id DESC).
    // The predicate already excludes the previous boundary row; do not also
    // pass Prisma cursor/skip, which would double-skip the first next row.
    if (cursor) {
      where.OR = [
        { updatedAt: { lt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
      ];
    }

    const page = await prisma.pipelineArtifact.findMany({
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
      orderBy: [
        { updatedAt: "desc" },
        { id: "desc" },
      ],
      take: Math.min(RAW_PAGE_SIZE, RAW_SCAN_CAP - artifacts.length),
    });

    scannedPages++;
    if (!Array.isArray(page) || page.length === 0) {
      exhausted = true;
      stopReason = "exhausted";
      break;
    }

    const rows = (page as HardSourceProfileRawRow[]).slice(0, RAW_SCAN_CAP - artifacts.length);
    artifacts.push(...rows);
    const current = aggregateHardSourceProfiles(artifacts);
    let postFilterTargets = requestedView === "active"
      ? filterActiveHardSourceRows(current)
      : requestedView === "history"
        ? filterResolvedHardSourceRows(current)
        : current;
    if (requestedView === "active") {
      postFilterTargets = await filterActiveRssTargets(postFilterTargets);
    }
    postFilterLogicalTargets = postFilterTargets.length;

    // A short page proves that no further row exists. A full page does not,
    // even when enough logical targets have already been found.
    const pageIsShort = rows.length < RAW_PAGE_SIZE;
    if (pageIsShort) {
      exhausted = true;
      stopReason = "exhausted";
      break;
    }
    // Reaching the hard bound is a safety stop even if this page happened to
    // produce enough logical targets. It must remain observable as a capped,
    // non-exhaustive scan rather than an ordinary requested-limit stop.
    if (artifacts.length >= RAW_SCAN_CAP) {
      stopReason = "scan_cap_reached";
      break;
    }
    if (postFilterLogicalTargets >= requestedLimit) {
      stopReason = "requested_limit_satisfied";
      break;
    }
    if (scannedPages >= MAX_SCAN_PAGES) {
      stopReason = "max_pages_reached";
      break;
    }

    const last = rows[rows.length - 1];
    if (!last) {
      exhausted = true;
      stopReason = "exhausted";
      break;
    }
    cursor = { updatedAt: last.updatedAt, id: last.id };
  }

  // This flag is reserved for the raw-row safety bound. A page-count bound
  // is separately observable through stopReason and must not be mislabeled as
  // the raw scan cap.
  const scanCapReached = stopReason === "scan_cap_reached";
  return {
    artifacts,
    scannedRows: artifacts.length,
    scannedPages,
    scanCapReached,
    exhausted,
    stopReason,
    postFilterLogicalTargets,
  };
}

async function filterActiveRssTargets(
  profiles: ReturnType<typeof aggregateHardSourceProfiles>,
): Promise<ReturnType<typeof aggregateHardSourceProfiles>> {
  const categoryIds = [...new Set(
    profiles
      .map((profile) => profile.categoryId)
      .filter((id): id is string => id !== null),
  )];
  if (categoryIds.length === 0) return profiles;

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
  for (const category of activeScopedCategories) {
    const evidence = validateDiscoveryEvidence(category.discoveryEvidence);
    if (isScopedCategoryFeed(category.pathUrl, category.rssFeedUrl, {
      scopeMatch: evidence?.scopeMatch,
      outcome: evidence ? { scopeMatch: evidence.scopeMatch } : undefined,
    })) {
      activeScopedCategoryIds.add(category.id);
    }
  }
  return profiles.filter((profile) => !(profile.categoryId && activeScopedCategoryIds.has(profile.categoryId)));
}

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "article-discovery-hard-source-profiles", 10, 60 * 1000);

  const query = getQuery(event);
  const limit = readBoundedNumber(query.limit, 50, 1, 200);
  const requestedView =
    typeof query.view === "string" && VALID_VIEWS.has(query.view)
      ? query.view
      : "active";

  const scan = await scanHardSourceArtifacts(limit, requestedView);
  let profiles = aggregateHardSourceProfiles(scan.artifacts);

  if (requestedView === "active") {
    profiles = filterActiveHardSourceRows(profiles);
    profiles = await filterActiveRssTargets(profiles);
  } else if (requestedView === "history") {
    profiles = filterResolvedHardSourceRows(profiles);
  }

  // Exhaustion, not the requested limit, determines whether total is known.
  // A full page that satisfies the limit is deliberately non-exhaustive.
  const resultTruncated = !scan.exhausted;
  return {
    ok: true,
    profiles: profiles.slice(0, limit),
    total: scan.exhausted ? profiles.length : null,
    view: requestedView,
    pagination: {
      scannedRows: scan.scannedRows,
      scannedPages: scan.scannedPages,
      scanCapReached: scan.scanCapReached,
      logicalTargetsFound: profiles.length,
      resultTruncated,
      exhausted: scan.exhausted,
      stopReason: scan.stopReason,
      earlyStopReason: scan.stopReason === "requested_limit_satisfied" ? scan.stopReason : null,
    },
  };
});
