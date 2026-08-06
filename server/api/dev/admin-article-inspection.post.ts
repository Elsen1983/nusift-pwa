import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import { getRequestPrisma } from "../../utils/request-prisma";
import {
  ADMIN_INSPECTION_POST_BODY_MAX_BYTES,
  parseAdminArticleInspectionBody,
  runAdminArticleInspection,
} from "../../services/admin-inspection";

/**
 * Production-safe all-active article inspection (Prompt 13H).
 *
 * The signed snapshot token returned by source inspection can reach ~52 KB at
 * the maximum supported active-target universe (500 source + 500 category
 * UUID-shaped IDs), which is unsafe as a GET query parameter: proxies,
 * browsers, Vercel routing and server request-line limits can reject it before
 * application validation. This read-only POST endpoint carries the token in a
 * bounded JSON body (64 KB cap → HTTP 413) with the same authorization, rate
 * limiting and validation semantics as the GET handler. The token is never
 * written to logs, diagnostics, error messages, browser history, or referrer
 * URLs.
 *
 * Explicit small target inspection remains on GET; this endpoint is reserved
 * for all-active snapshot requests and rejects explicit target selection.
 */
export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  await assertRateLimit(event, "admin-article-inspection", 30, 60 * 1000);
  const db = getRequestPrisma(event as unknown as { context?: Record<string, unknown> });
  // Cheap pre-flight: reject an oversized declared content-length with HTTP 413
  // before buffering the body (defense-in-depth; the parse cap inside
  // parseAdminArticleInspectionBody remains the authoritative bound).
  const declaredLength = Number(event.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > ADMIN_INSPECTION_POST_BODY_MAX_BYTES) {
    throw createError({ statusCode: 413, statusMessage: "Request body too large." });
  }
  const raw = await readRawBody(event, false);
  const body = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : undefined;
  const params = parseAdminArticleInspectionBody(body);
  if (params.targetIds !== undefined || params.allActive === false) {
    throw createError({ statusCode: 400, statusMessage: "POST inspection is reserved for all-active snapshot requests." });
  }
  return runAdminArticleInspection(db, userId, { ...params, allActive: true });
});
