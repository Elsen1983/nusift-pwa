import { prisma } from "../prisma";
import { stableTargetKey } from "./text";

export type HostCooldownEvidence = {
  retryAfterAt: string;
  rateLimitedAt: string | null;
  reason: "http_429";
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

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
  }> = [];
  let cursor: string | undefined;
  do {
    const page = await prisma.pipelineArtifact.findMany({
      where: {
        artifactType: "article_discovery_headless_required",
        updatedAt: { gte: new Date(Date.now() - 4 * 60 * 60 * 1000) },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        sourceId: true,
        categoryId: true,
        payload: true,
      },
    });
    artifacts.push(...page);
    cursor = page.length === 500 ? page[page.length - 1]!.id : undefined;
  } while (cursor);

  const now = Date.now();
  const seenTargets = new Set<string>();
  const byHost = new Map<string, HostCooldownEvidence>();

  for (const artifact of artifacts) {
    const payload =
      artifact.payload && typeof artifact.payload === "object" && !Array.isArray(artifact.payload)
        ? artifact.payload as Record<string, unknown>
        : {};
    const targetUrl = readString(payload.targetUrl);
    const targetKey =
      readString(payload.targetKey) ??
      stableTargetKey(artifact.sourceId, artifact.categoryId, targetUrl);
    if (!targetKey || seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);

    if (payload.browserRateLimited !== true || !targetUrl) continue;
    const retryAfterAt = readString(payload.browserRetryAfterAt) ?? readString(payload.browserCooldownUntil);
    const retryAfterMs = retryAfterAt ? Date.parse(retryAfterAt) : Number.NaN;
    if (!retryAfterAt || !Number.isFinite(retryAfterMs) || retryAfterMs <= now) continue;

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
        rateLimitedAt: readString(payload.browserRateLimitedAt),
        reason: "http_429",
      });
    }
  }

  return byHost;
}
