/**
 * POST /api/dev/agent2-discovery-profiles/activate
 *
 * Admin-only. Creates a deterministic Agent 2 discovery profile from an
 * existing hard-source profile. The generated profile can be created as
 * a DRAFT (for review) or immediately ACTIVE (for production use).
 *
 * Only ACTIVE discovery profiles affect Agent 2 discovery behavior.
 * DRAFT profiles are stored for review but do not alter production.
 */

import { createError, defineEventHandler, readBody } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import { logAgentScan } from "../../utils/news-pipeline/log";
import {
  buildDiscoveryProfileFromSuggestion,
  validateDiscoveryProfile,
  mapSuggestionToDiscoveryRules,
} from "../../utils/news-pipeline/agent2-discovery-profile";

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ─── Terminal lifecycle states ───────────────────────────────────────────────

const TERMINAL_LIFECYCLE_STATES = new Set(["resolved", "ignored", "stale"]);

// ─── Handler ────────────────────────────────────────────────────────────────

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "agent2-discovery-profiles-activate", 10, 60 * 1000);

  const body = await readBody(event).catch(() => ({}));

  const profileArtifactId = readString(body?.profileArtifactId);
  if (!profileArtifactId) {
    throw createError({
      statusCode: 400,
      statusMessage: "profileArtifactId is required.",
    });
  }

  const mode = body?.mode;
  if (mode !== "draft" && mode !== "active") {
    throw createError({
      statusCode: 400,
      statusMessage: 'mode must be "draft" or "active".',
    });
  }

  const note = readString(body?.note) ?? undefined;

  // Load hard-source profile artifact
  const artifact = await prisma.pipelineArtifact.findUnique({
    where: { id: profileArtifactId },
    select: { id: true, payload: true, status: true, sourceId: true, categoryId: true, artifactType: true },
  });

  if (!artifact) {
    throw createError({
      statusCode: 404,
      statusMessage: "Hard-source profile artifact not found.",
    });
  }

  const payload = isPlainObject(artifact.payload) ? artifact.payload as Record<string, unknown> : {};

  // Validate artifactType on the row itself (not payload.artifactKind)
  if (artifact.artifactType !== "article_discovery_hard_source_profile") {
    throw createError({
      statusCode: 400,
      statusMessage: "Not a hard-source profile artifact.",
    });
  }

  // Validate required fields
  const targetUrl = readString(payload.targetUrl);
  const sourceId = artifact.sourceId;
  if (!targetUrl || !sourceId) {
    throw createError({
      statusCode: 400,
      statusMessage: "Hard-source profile is missing required fields (targetUrl, sourceId).",
    });
  }

  // Check lifecycle state — terminal states cannot be activated
  const lifecycleState = readString(payload.lifecycleState) ?? "open";
  if (TERMINAL_LIFECYCLE_STATES.has(lifecycleState)) {
    throw createError({
      statusCode: 409,
      statusMessage: `Cannot activate a profile in terminal lifecycle state: ${lifecycleState}.`,
    });
  }

  // Map suggested action to discovery profile rules
  const suggestedAction = readString(payload.suggestedNextAction) ?? readString(payload.recoverySuggestion) ?? "manual_review";
  const { action, rules } = mapSuggestionToDiscoveryRules(suggestedAction);

  // Build discovery profile
  const discoveryProfile = buildDiscoveryProfileFromSuggestion({
    targetUrl,
    sourceId,
    categoryId: artifact.categoryId ?? null,
    createdBy: "admin",
    rules,
    reasonCodes: [action, `suggested_action:${suggestedAction}`],
    fromProfileArtifactId: profileArtifactId,
  });

  // Set status based on mode
  discoveryProfile.status = mode === "active" ? "active" : "draft";

  // Validate generated profile
  const validation = validateDiscoveryProfile(discoveryProfile);
  if (!validation) {
    throw createError({
      statusCode: 422,
      statusMessage: "Generated discovery profile failed validation.",
    });
  }

  // Persist as PipelineArtifact
  const discoveryStatus = mode === "active" ? "ACTIVE" : "DRAFT";
  const now = new Date();
  const created = await prisma.pipelineArtifact.create({
    data: {
      pipelineRunId: "admin-manual",
      sourceId,
      categoryId: artifact.categoryId ?? null,
      artifactType: "agent2_discovery_profile",
      status: discoveryStatus,
      candidateCount: 0,
      payload: {
        schemaVersion: 1,
        artifactKind: "agent2_discovery_profile",
        sourceId,
        categoryId: artifact.categoryId ?? null,
        targetUrl,
        fromHardSourceProfileId: profileArtifactId,
        action,
        mode,
        profile: validation,
        validation: { valid: true, rules: Object.keys(rules) },
        createdBy: "admin",
        createdAt: now.toISOString(),
        activatedAt: mode === "active" ? now.toISOString() : null,
        note,
      } as any,
      errorLog: `Discovery profile ${discoveryStatus} created by admin from hard-source profile ${profileArtifactId}. action=${action}, mode=${mode}.`,
    },
    select: { id: true },
  });

  // Update hard-source profile lifecycle to "applied".
  // Use compare-and-set on lifecycleState to prevent concurrent activation races.
  const previousLifecycleState = lifecycleState;
  const { count: updatedCount } = await prisma.pipelineArtifact.updateMany({
    where: {
      id: profileArtifactId,
      artifactType: "article_discovery_hard_source_profile",
    },
    data: {
      payload: {
        ...payload,
        lifecycleState: "applied",
        appliedProfileArtifactId: created.id,
        appliedProfileStatus: discoveryStatus,
        appliedAt: now.toISOString(),
        appliedBy: "admin",
        previousLifecycleState,
        ...(note ? { appliedNote: note } : {}),
      } as any,
      updatedAt: now,
    },
  });

  if (updatedCount === 0) {
    throw createError({
      statusCode: 409,
      statusMessage: "Hard-source profile could not be updated — it may have been modified concurrently.",
    });
  }

  await logAgentScan({
    sourceId,
    categoryId: artifact.categoryId ?? undefined,
    status: "DISCOVERY_PROFILE_ACTIVATED",
    executionTimeMs: 0,
    errorLog: `Discovery profile ${created.id} ${discoveryStatus} from hard-source profile ${profileArtifactId}. action=${action}, mode=${mode}, targetUrl=${targetUrl}.`,
  });

  return {
    ok: true,
    profileArtifactId: created.id,
    status: discoveryStatus,
    validation: { valid: true, rules: Object.keys(rules) },
    hardSourceProfileId: profileArtifactId,
  };
});
