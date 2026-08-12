import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

export const RUN_TARGET_MANIFEST_ARTIFACT = "orchestration_target_manifest";
export const RUN_TARGET_FUNNEL_ARTIFACT = "orchestration_target_funnel";
const MANIFEST_LIMIT = 50;
const SCAN_PAGE_SIZE = 200;
const SCAN_LIMIT = 2_000;

export type FunnelTerminalReason =
  | "produced_publishable_articles"
  | "produced_unpublished_articles"
  | "all_duplicates"
  | "feed_missing_or_invalid"
  | "feed_unverified"
  | "feed_first_waiting_evidence"
  | "robots_disallowed"
  | "host_cooldown"
  | "governor_deferred"
  | "budget_deferred"
  | "url_policy_rejected_all"
  | "no_candidates_found"
  | "enrichment_failed"
  | "enrichment_deferred"
  | "quarantined"
  | "stage_not_reached"
  | "evidence_incomplete";

export type RunManifestTarget = {
  sourceId: string;
  categoryId?: string | null;
  disposition?: "selected" | "budget_deferred" | "policy_skipped";
  reason?: string | null;
  selectedCount?: number;
};

const targetKey = (sourceId: string, categoryId: string | null) =>
  `${sourceId}:${categoryId ?? "source"}`;

const boundedReason = (value: unknown): string | null =>
  typeof value === "string" ? value.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 160) : null;

export async function persistRunTargetManifest(input: {
  pipelineRunId: string;
  orchestrationRunId: string;
  stage: "agent1" | "agent2-static" | "agent2-headless" | "agent3";
  targets: readonly RunManifestTarget[];
  truncated?: boolean;
}): Promise<{ persisted: number; truncated: boolean }> {
  const bounded = input.targets.slice(0, MANIFEST_LIMIT);
  if (bounded.length === 0) return { persisted: 0, truncated: false };
  await prisma.pipelineArtifact.createMany({
    data: bounded.map((target, index) => ({
      pipelineRunId: input.pipelineRunId,
      orchestrationRunId: input.orchestrationRunId,
      sourceId: target.sourceId,
      categoryId: target.categoryId ?? null,
      artifactType: RUN_TARGET_MANIFEST_ARTIFACT,
      status: (target.disposition ?? "selected").toUpperCase(),
      candidateCount: 0,
      payload: {
        schemaVersion: 1,
        artifactKind: RUN_TARGET_MANIFEST_ARTIFACT,
        stage: input.stage,
        targetKey: targetKey(target.sourceId, target.categoryId ?? null),
        disposition: target.disposition ?? "selected",
        reason: boundedReason(target.reason),
        ordinal: index,
        manifestTruncated: input.truncated === true || input.targets.length > MANIFEST_LIMIT,
        selectedCount: Math.max(0, Math.trunc(target.selectedCount ?? 1)),
      } satisfies Prisma.InputJsonValue,
      errorLog: null,
    })),
  });
  return { persisted: bounded.length, truncated: input.truncated === true || input.targets.length > MANIFEST_LIMIT };
}

export type FunnelState = {
  sourceId: string;
  categoryId: string | null;
  manifest: boolean;
  manifestTruncated: boolean;
  manifestStages: Set<string>;
  outcomeStages: Set<string>;
  feedItemsParsed: number;
  candidatesDiscovered: number;
  candidatesEvaluated: number;
  candidatesPolicyAccepted: number;
  candidatesPersisted: number;
  duplicates: number;
  persistenceFailed: number;
  enriched: number;
  enrichmentFailed: number;
  publishable: number;
  articlesSelected: number;
  deferred: boolean;
  quarantined: boolean;
  reasons: Set<string>;
};

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const countOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

export function chooseFunnelTerminalReason(state: FunnelState): FunnelTerminalReason {
  if (state.publishable > 0) return "produced_publishable_articles";
  if (state.candidatesPersisted > 0 || state.enriched > 0) return "produced_unpublished_articles";
  if (state.quarantined) return "quarantined";
  if (state.reasons.has("robots_disallowed")) return "robots_disallowed";
  if (state.reasons.has("governor_deferred")) return "governor_deferred";
  if (state.reasons.has("feed_missing_or_invalid") || state.reasons.has("rss_pending_discovery")) return "feed_missing_or_invalid";
  if (state.reasons.has("feed_unverified")) return "feed_unverified";
  if (
    state.reasons.has("rss_owned_waiting_evidence") ||
    state.reasons.has("rss_active_waiting_for_second_nonproductive_run") ||
    state.reasons.has("rss_owned_productive") ||
    state.reasons.has("rss_active_productive")
  ) return "feed_first_waiting_evidence";
  if (state.reasons.has("rate_limited") || state.reasons.has("host_cooldown")) return "host_cooldown";
  if (state.reasons.has("time_budget") || state.reasons.has("max_targets")) return "budget_deferred";
  if (state.deferred) return "enrichment_deferred";
  if (state.reasons.has("url_policy_rejected_all")) return "url_policy_rejected_all";
  if (state.duplicates > 0 && state.persistenceFailed === 0) return "all_duplicates";
  if (state.enrichmentFailed > 0) return "enrichment_failed";
  if (state.candidatesDiscovered === 0 && state.manifest) return "no_candidates_found";
  if (!state.manifest) return "evidence_incomplete";
  return "evidence_incomplete";
}

const funnelId = (orchestrationRunId: string, key: string) =>
  `funnel_${createHash("sha256").update(`${orchestrationRunId}:${key}`).digest("hex").slice(0, 40)}`;

export async function finalizeOrchestrationFunnels(input: {
  orchestrationRunId: string;
}): Promise<{ targets: number; truncated: boolean; incomplete: number }> {
  // Primary artifacts carry the correlation ID at creation. This bounded
  // reconciliation attributes secondary artifacts created by the same batch
  // run without adding orchestration lookups inside hot item loops.
  const owningRuns = await prisma.pipelineArtifact.findMany({
    where: { orchestrationRunId: input.orchestrationRunId },
    distinct: ["pipelineRunId"],
    take: 100,
    select: { pipelineRunId: true },
  });
  if (owningRuns.length > 0) {
    await prisma.pipelineArtifact.updateMany({
      where: {
        orchestrationRunId: null,
        pipelineRunId: { in: owningRuns.map((row) => row.pipelineRunId) },
      },
      data: { orchestrationRunId: input.orchestrationRunId },
    });
  }
  const rows: Array<{
    id: string;
    artifactType: string;
    status: string;
    sourceId: string | null;
    categoryId: string | null;
    candidateCount: number;
    payload: unknown;
  }> = [];
  let cursor: string | undefined;
  while (rows.length < SCAN_LIMIT) {
    const page = await prisma.pipelineArtifact.findMany({
      where: {
        orchestrationRunId: input.orchestrationRunId,
        artifactType: { not: RUN_TARGET_FUNNEL_ARTIFACT },
      },
      orderBy: { id: "asc" },
      take: Math.min(SCAN_PAGE_SIZE, SCAN_LIMIT - rows.length),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        artifactType: true,
        status: true,
        sourceId: true,
        categoryId: true,
        candidateCount: true,
        payload: true,
      },
    });
    rows.push(...page);
    if (page.length < SCAN_PAGE_SIZE) break;
    cursor = page.at(-1)?.id;
  }
  const truncated = rows.length === SCAN_LIMIT;
  const states = new Map<string, FunnelState>();
  for (const row of rows) {
    if (!row.sourceId) continue;
    const key = targetKey(row.sourceId, row.categoryId);
    const state = states.get(key) ?? {
      sourceId: row.sourceId,
      categoryId: row.categoryId,
      manifest: false,
      manifestTruncated: false,
      manifestStages: new Set<string>(),
      outcomeStages: new Set<string>(),
      feedItemsParsed: 0,
      candidatesDiscovered: 0,
      candidatesEvaluated: 0,
      candidatesPolicyAccepted: 0,
      candidatesPersisted: 0,
      duplicates: 0,
      persistenceFailed: 0,
      enriched: 0,
      enrichmentFailed: 0,
      publishable: 0,
      articlesSelected: 0,
      deferred: false,
      quarantined: false,
      reasons: new Set<string>(),
    };
    states.set(key, state);
    const payload = recordOf(row.payload);
    if (row.artifactType === RUN_TARGET_MANIFEST_ARTIFACT) {
      state.manifest = true;
      state.manifestTruncated ||= payload.manifestTruncated === true;
      if (typeof payload.stage === "string") {
        state.manifestStages.add(payload.stage);
        if (payload.stage === "agent3") state.articlesSelected += countOf(payload.selectedCount);
        if (payload.disposition === "policy_skipped") state.outcomeStages.add(payload.stage);
      }
      if (typeof payload.reason === "string") state.reasons.add(payload.reason);
    } else if (row.artifactType === "agent1_target_outcome") {
      state.outcomeStages.add("agent1");
      state.feedItemsParsed += countOf(payload.candidates);
      state.candidatesDiscovered += countOf(payload.candidates);
      state.candidatesEvaluated += countOf(payload.candidates);
      state.candidatesPolicyAccepted += countOf(payload.candidates);
      state.candidatesPersisted += countOf(payload.inserted);
      state.duplicates += countOf(payload.skipped);
      state.persistenceFailed += countOf(payload.failed);
      if (payload.handedToAgent2 === true) state.reasons.add("feed_missing_or_invalid");
      const skipSummary = recordOf(payload.skipSummary);
      if (countOf(skipSummary.urlPolicyRejected) > 0 && countOf(payload.candidates) === 0) {
        state.reasons.add("url_policy_rejected_all");
      }
      if (typeof payload.deferredReason === "string") state.reasons.add(payload.deferredReason);
      state.deferred ||= payload.deferred === true;
    } else if (row.artifactType === "agent2_target_outcome") {
      state.outcomeStages.add("agent2-static");
      state.candidatesDiscovered += countOf(payload.candidates);
      state.candidatesEvaluated += countOf(payload.evaluated);
      state.candidatesPolicyAccepted += countOf(payload.candidates);
      state.candidatesPersisted += countOf(payload.inserted);
      state.duplicates += countOf(payload.skipped);
      state.persistenceFailed += countOf(payload.failed);
      if (typeof payload.reason === "string") state.reasons.add(payload.reason);
    } else if (row.artifactType === "article_discovery_headless_required") {
      state.outcomeStages.add("agent2-headless");
      state.candidatesDiscovered += countOf(payload.acceptedCount);
      state.candidatesEvaluated += countOf(payload.evaluatedCount);
      state.candidatesPolicyAccepted += countOf(payload.acceptedCount);
      state.deferred ||= /PENDING|PROCESSING/.test(row.status);
    } else if (row.artifactType === "article_enrichment_result") {
      state.outcomeStages.add("agent3");
      if (row.status === "CAPTURED") state.enriched += 1;
      const attribution = recordOf(payload.runAttribution);
      if (attribution.madePublishable === true) state.publishable += 1;
    } else if (row.artifactType === "article_enrichment_rejection") {
      state.outcomeStages.add("agent3");
      state.enrichmentFailed += 1;
    }
    state.deferred ||= /DEFERRED|PENDING/.test(row.status);
    state.quarantined ||= row.status === "QUARANTINED";
  }

  let incomplete = 0;
  for (const [key, state] of states) {
    const hasOutcomeGap = [...state.manifestStages].some((stage) => !state.outcomeStages.has(stage));
    const evidenceComplete = state.manifest && !state.manifestTruncated && !truncated && !hasOutcomeGap;
    const evidenceReason = chooseFunnelTerminalReason(state);
    const terminalReason = evidenceReason.startsWith("produced_")
      ? evidenceReason
      : hasOutcomeGap && state.manifest
        ? "stage_not_reached"
        : !evidenceComplete && evidenceReason === "evidence_incomplete"
          ? "evidence_incomplete"
          : evidenceReason;
    if (!evidenceComplete || terminalReason === "evidence_incomplete") incomplete += 1;
    const data = {
      pipelineRunId: input.orchestrationRunId,
      orchestrationRunId: input.orchestrationRunId,
      sourceId: state.sourceId,
      categoryId: state.categoryId,
      artifactType: RUN_TARGET_FUNNEL_ARTIFACT,
      status: evidenceComplete ? "CAPTURED" : "INCOMPLETE",
      candidateCount: state.candidatesPersisted,
      payload: {
        schemaVersion: 1,
        artifactKind: RUN_TARGET_FUNNEL_ARTIFACT,
        targetKey: key,
        terminalReason,
        counters: {
          feedItemsParsed: state.feedItemsParsed,
          candidatesDiscovered: state.candidatesDiscovered,
          candidatesEvaluated: state.candidatesEvaluated,
          candidatesPolicyAccepted: state.candidatesPolicyAccepted,
          candidatesPersisted: state.candidatesPersisted,
          duplicates: state.duplicates,
          persistenceFailed: state.persistenceFailed,
          articlesSelected: state.articlesSelected,
          articlesEnriched: state.enriched,
          enrichmentFailed: state.enrichmentFailed,
          articlesPublishable: state.publishable,
        },
        availability: {
          manifest: state.manifest,
          manifestTruncated: state.manifestTruncated,
          scanTruncated: truncated,
          feedItemsParsed: state.outcomeStages.has("agent1") ? "available" : state.manifestStages.has("agent1") ? "metric_unreported" : "stage_absent",
          candidatesEvaluated: state.outcomeStages.has("agent1") || state.outcomeStages.has("agent2-static") ? "available" : "metric_unreported",
          candidatesPersisted: state.outcomeStages.has("agent1") || state.outcomeStages.has("agent2-static") ? "available" : "metric_unreported",
          articlesSelected: state.manifestStages.has("agent3") ? "available" : "stage_absent",
          articlesEnriched: state.outcomeStages.has("agent3") ? "available" : state.manifestStages.has("agent3") ? "metric_unreported" : "stage_absent",
          articlesPublishable: state.outcomeStages.has("agent3") ? "available" : state.manifestStages.has("agent3") ? "metric_unreported" : "stage_absent",
          manifestStages: [...state.manifestStages].slice(0, 4),
          outcomeStages: [...state.outcomeStages].slice(0, 4),
        },
        evidenceComplete,
      } satisfies Prisma.InputJsonValue,
      errorLog: evidenceComplete ? null : "Run funnel evidence is incomplete or truncated.",
    };
    await prisma.pipelineArtifact.upsert({
      where: { id: funnelId(input.orchestrationRunId, key) },
      create: { id: funnelId(input.orchestrationRunId, key), ...data },
      update: data,
    });
  }
  return { targets: states.size, truncated, incomplete };
}

export const RUN_FUNNEL_QUERY_PAGE_MAX = 100;

export async function getRunFunnelPage(input: {
  orchestrationRunId: string;
  cursor?: string | null;
  limit?: number;
}) {
  const limit = Math.max(1, Math.min(RUN_FUNNEL_QUERY_PAGE_MAX, Math.trunc(input.limit ?? 25)));
  const rows = await prisma.pipelineArtifact.findMany({
    where: {
      orchestrationRunId: input.orchestrationRunId,
      artifactType: RUN_TARGET_FUNNEL_ARTIFACT,
    },
    orderBy: { id: "asc" },
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      sourceId: true,
      categoryId: true,
      status: true,
      createdAt: true,
      payload: true,
    },
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    truncated: hasMore,
    limit,
  };
}
