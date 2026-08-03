import { createError, readBody } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import {
  findRuntimeEvidenceOnlyProfiles,
  repairRuntimeEvidenceOnlyProfiles,
} from "../../utils/news-pipeline/hard-source-repair";

/**
 * Admin repair action for hard-source profiles created solely from
 * platform/runtime evidence (BROWSER_RUNTIME_UNAVAILABLE / FALLBACK_DISABLED).
 *
 * DRY-RUN BY DEFAULT: writes only happen when the caller explicitly passes
 * `dryRun: false`. Bounded scan (max 500 artifacts). Admin-authorized and
 * rate-limited. Never touches production pipeline state beyond invalidating
 * the matching invalid profiles.
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "hard-source-repair", 5, 60 * 1000);

  let body: { dryRun?: boolean; scanLimit?: number; confirmation?: string } = {};
  try {
    body = await readBody(event);
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid JSON body." });
  }

  const dryRun = body.dryRun !== false;
  if (!dryRun && body.confirmation !== "REPAIR_RUNTIME_ONLY_HARD_SOURCE_PROFILES") {
    throw createError({
      statusCode: 400,
      statusMessage: "Exact repair confirmation token required.",
    });
  }
  const scanLimit = typeof body.scanLimit === "number" && Number.isFinite(body.scanLimit)
    ? Math.min(Math.max(Math.round(body.scanLimit), 1), 500)
    : undefined;

  const result = await repairRuntimeEvidenceOnlyProfiles({ dryRun, scanLimit });

  return {
    ok: true,
    dryRun: result.dryRun,
    scanned: result.scanned,
    matched: result.matched,
    updated: result.updated,
    failed: result.failed,
    profiles: result.profiles.map((profile) => ({
      id: profile.id,
      sourceId: profile.sourceId,
      categoryId: profile.categoryId,
      targetUrl: profile.targetUrl,
      staticQuality: profile.staticQuality,
      browserStatus: profile.browserStatus,
      failureCount: profile.failureCount,
      createdAt: profile.createdAt,
    })),
  };
});

// Read-only dry-run preview endpoint support (same bounded query).
export async function previewHardSourceRepair(): Promise<unknown> {
  const profiles = await findRuntimeEvidenceOnlyProfiles();
  return {
    ok: true,
    dryRun: true,
    matched: profiles.length,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      sourceId: profile.sourceId,
      categoryId: profile.categoryId,
      targetUrl: profile.targetUrl,
      browserStatus: profile.browserStatus,
      failureCount: profile.failureCount,
    })),
  };
}
