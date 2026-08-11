import { prisma } from "../prisma";
import { stableTargetKey } from "./text";
import {
  boundStaticRetryAfterTimestamp,
  STATIC_RETRY_AFTER_MAX_MS,
  type StaticDiscoveryRetryAfterSource,
} from "./retry-after-policy";
import type { StaticDiscoveryRateLimitEvidence } from "./article-discovery-helpers";

export type HostCooldownEvidence = {
  retryAfterAt: string;
  rateLimitedAt: string | null;
  reason: "http_429";
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

type CooldownCandidate = {
  retryAfterAt: string;
  retryAfterSource: StaticDiscoveryRetryAfterSource | null;
  rateLimitedAt: string | null;
};

function readEvidenceArray(value: unknown): StaticDiscoveryRateLimitEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is StaticDiscoveryRateLimitEvidence => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    return candidate.status === 429 && typeof candidate.url === "string" && typeof candidate.retryAfterAt === "string";
  });
}

function readCooldownCandidates(payload: Record<string, unknown>): CooldownCandidate[] {
  const candidates: CooldownCandidate[] = [];

  // 1. Browser detail/listing cooldown fields remain authoritative for browser
  // artifacts. If those fields are stale, the loader still falls through to
  // newer Prompt 15A static evidence in the same payload.
  if (payload.browserRateLimited === true) {
    const retryAfterAt = readString(payload.browserRetryAfterAt) ?? readString(payload.browserCooldownUntil);
    if (retryAfterAt) {
      candidates.push({
        retryAfterAt,
        retryAfterSource: "fallback",
        rateLimitedAt: readString(payload.browserRateLimitedAt),
      });
    }
  }

  const staticDiscovery = payload.staticDiscovery && typeof payload.staticDiscovery === "object" && !Array.isArray(payload.staticDiscovery)
    ? payload.staticDiscovery as Record<string, unknown>
    : null;

  // 2. Namespaced Prompt 15A evidence.
  const namespacedEvidence = readEvidenceArray(staticDiscovery?.rateLimitEvidence);
  const namespacedRetryAfter = readString(staticDiscovery?.retryAfterAt);
  const namespacedStopReason = readString(staticDiscovery?.stopReason);
  if (namespacedStopReason === "rate_limited" || namespacedEvidence.length > 0) {
    const evidence = namespacedEvidence[0];
    const retryAfterAt = namespacedRetryAfter ?? evidence?.retryAfterAt ?? null;
    if (retryAfterAt) {
      candidates.push({
        retryAfterAt,
        retryAfterSource: (readString(staticDiscovery?.retryAfterSource) ?? evidence?.retryAfterSource ?? null) as StaticDiscoveryRetryAfterSource | null,
        rateLimitedAt: readString(staticDiscovery?.rateLimitedAt),
      });
    }
  }

  // 3. Top-level Prompt 15A compatibility aliases.
  const topLevelEvidence = readEvidenceArray(payload.rateLimitEvidence);
  const topLevelRetryAfter = readString(payload.retryAfterAt);
  const topLevelStopReason = readString(payload.stopReason) ?? readString(payload.detailEvaluationStoppedReason);
  if (topLevelStopReason === "rate_limited" || topLevelEvidence.length > 0) {
    const evidence = topLevelEvidence[0];
    const retryAfterAt = topLevelRetryAfter ?? evidence?.retryAfterAt ?? null;
    if (retryAfterAt) {
      candidates.push({
        retryAfterAt,
        retryAfterSource: (readString(payload.retryAfterSource) ?? evidence?.retryAfterSource ?? null) as StaticDiscoveryRetryAfterSource | null,
        rateLimitedAt: readString(payload.rateLimitedAt),
      });
    }
  }

  // 4. Request-budget exhaustion without status 429 intentionally contributes
  // no candidate. Structured rateLimitEvidence is covered by the preceding
  // top-level evidence path and must include status 429.
  return candidates;
}

const isActiveCooldownCandidate = (candidate: CooldownCandidate, now: number): boolean => {
  const rawRetryAfterMs = Date.parse(candidate.retryAfterAt);
  if (!Number.isFinite(rawRetryAfterMs) || rawRetryAfterMs <= now) return false;
  const bounded = boundStaticRetryAfterTimestamp(candidate.retryAfterAt, candidate.retryAfterSource, now);
  const retryAfterMs = Date.parse(bounded.retryAfterAt);
  return Number.isFinite(retryAfterMs) && retryAfterMs > now;
};

/**
 * Reduces the newest persisted state per stable target key, then combines
 * active target cooldowns by hostname. A newer state for the same target
 * supersedes its older 429; unrelated targets on the host remain independent.
 */
export async function loadPersistedHostCooldowns(): Promise<Map<string, HostCooldownEvidence>> {
  const artifacts: Array<{
    id: string;
    sourceId: string | null;
    categoryId: string | null;
    payload: unknown;
    updatedAt?: Date;
  }> = [];
  let cursor: string | undefined;
  // Keep the database lookup window aligned with the maximum bounded static
  // Retry-After policy. The in-memory expiry check below remains authoritative,
  // so this is only a bounded candidate window, not a cooldown grant.
  const lookupSince = new Date(Date.now() - STATIC_RETRY_AFTER_MAX_MS);
  do {
    const page = await prisma.pipelineArtifact.findMany({
      where: {
        artifactType: "article_discovery_headless_required",
        updatedAt: { gte: lookupSince },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        sourceId: true,
        categoryId: true,
        payload: true,
        updatedAt: true,
      },
    });
    artifacts.push(...page);
    cursor = page.length === 500 ? page[page.length - 1]!.id : undefined;
  } while (cursor);

  const now = Date.now();
  const seenTargets = new Set<string>();
  const byHost = new Map<string, HostCooldownEvidence>();

  for (const artifact of artifacts) {
    // Prisma's where clause is the primary bounded lookup. Keep the same
    // boundary at the trust boundary as well, which protects tests/adapters
    // that may return a broader page than requested.
    if (artifact.updatedAt && artifact.updatedAt.getTime() < lookupSince.getTime()) continue;
    const payload =
      artifact.payload && typeof artifact.payload === "object" && !Array.isArray(artifact.payload)
        ? artifact.payload as Record<string, unknown>
        : {};
    const targetUrl = readString(payload.targetUrl);
    if (!targetUrl) continue;
    const derivedTargetKey = stableTargetKey(artifact.sourceId, artifact.categoryId, targetUrl);
    if (!derivedTargetKey) continue;
    const persistedTargetKey = readString(payload.targetKey);
    if (persistedTargetKey && persistedTargetKey !== derivedTargetKey) continue;
    const targetKey = derivedTargetKey;
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);

    const candidate = readCooldownCandidates(payload).find((entry) => isActiveCooldownCandidate(entry, now));
    if (!candidate) continue;
    const bounded = boundStaticRetryAfterTimestamp(
      candidate.retryAfterAt,
      candidate.retryAfterSource,
      now,
    );
    const retryAfterAt = bounded.retryAfterAt;
    const retryAfterMs = Date.parse(retryAfterAt);
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= now) continue;

    let hostname: string;
    try {
      hostname = new URL(targetUrl).hostname.toLowerCase();
    } catch {
      continue;
    }

    const current = byHost.get(hostname);
    if (!current || Date.parse(current.retryAfterAt) < retryAfterMs) {
      byHost.set(hostname, {
        retryAfterAt,
        rateLimitedAt: candidate.rateLimitedAt ?? readString(payload.browserRateLimitedAt),
        reason: "http_429",
      });
    }
  }

  return byHost;
}
