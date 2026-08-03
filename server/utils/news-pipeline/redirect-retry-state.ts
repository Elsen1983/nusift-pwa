import { createHash } from "node:crypto";
import { prisma } from "../prisma";
import { normalizeUrl } from "./text";
import type { SafeRedirectFailureKind, SafeRedirectEvidence } from "../safe-redirect-resolver";

export const REDIRECT_RETRY_ARTIFACT_TYPE = "agent1_redirect_retry";
const MAX_STATE_SCAN = 200;
const MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;

type RedirectArtifactStatus =
  | "RETRYABLE"
  | "RESOLVED"
  | "SECURITY_REJECTED"
  | "INVALID_REDIRECT"
  | "EXHAUSTED";

export type RedirectRetryKey = {
  normalizedUrl: string;
  urlHash: string;
};

export type RedirectRetryState = RedirectRetryKey & {
  sourceId: string;
  categoryId: string | null;
  failureKind: SafeRedirectFailureKind;
  attemptCount: number;
  nextRetryAt: string | null;
  httpStatus: number | null;
  retryAfterMs: number | null;
  redirectCount: number;
  lastFailureAt: string;
  terminalAt: string | null;
  status: RedirectArtifactStatus;
};

const boundedString = (value: string, max: number) => value.slice(0, max);
const terminalStatuses = new Set<RedirectArtifactStatus>([
  "SECURITY_REJECTED",
  "INVALID_REDIRECT",
  "EXHAUSTED",
]);

/** Normalize URL identity for matching while keeping query values out of evidence. */
export function buildRedirectRetryKey(url: string): RedirectRetryKey | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  return {
    normalizedUrl: normalized,
    urlHash: createHash("sha256").update(normalized).digest("hex").slice(0, 64),
  };
}

export function sanitizeRedirectUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const keys = [...new Set([...parsed.searchParams.keys()])];
    const redactedQuery = keys.map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&");
    return boundedString(`${parsed.origin}${parsed.pathname}${redactedQuery ? `?${redactedQuery}` : ""}`, 500);
  } catch {
    return boundedString(url.replace(/([?&][^=&#]+)=([^&#]*)/g, "$1=[redacted]"), 500);
  }
}

const retryDelay = (failureKind: SafeRedirectFailureKind, retryAfterMs: number | null) => {
  if (failureKind === "rate_limited") {
    return Math.min(MAX_RETRY_MS, Math.max(0, retryAfterMs ?? DEFAULT_RETRY_MS));
  }
  return DEFAULT_RETRY_MS;
};

const readStatus = (value: unknown): RedirectArtifactStatus | null =>
  typeof value === "string" &&
  ["RETRYABLE", "RESOLVED", "SECURITY_REJECTED", "INVALID_REDIRECT", "EXHAUSTED"].includes(value)
    ? value as RedirectArtifactStatus
    : null;

const readFailureKind = (value: unknown): SafeRedirectFailureKind =>
  value === "security_rejected" || value === "invalid_redirect" || value === "rate_limited"
    ? value
    : "transient_network";

const readNumber = (value: unknown, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0;

async function findLatestState(sourceId: string, categoryId: string | null, urlHash: string) {
  const artifacts = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: REDIRECT_RETRY_ARTIFACT_TYPE,
      sourceId,
      categoryId,
    },
    orderBy: { createdAt: "desc" },
    take: MAX_STATE_SCAN,
    select: { id: true, payload: true, status: true },
  });
  for (const artifact of artifacts) {
    const payload = artifact.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const raw = payload as Record<string, unknown>;
    if (raw.urlHash !== urlHash) continue;
    return { id: artifact.id, payload: raw, status: artifact.status };
  }
  return null;
}

const stateFromArtifact = (
  latest: { payload: Record<string, unknown>; status: string },
  input: { sourceId: string; categoryId: string | null },
  key: RedirectRetryKey,
): RedirectRetryState | null => {
  const status = readStatus(latest.status) || readStatus(latest.payload.status);
  if (!status || status === "RESOLVED") return null;
  const terminal = terminalStatuses.has(status);
  const attemptCount = status === "EXHAUSTED"
    ? MAX_ATTEMPTS
    : Math.min(MAX_ATTEMPTS, Math.max(1, readNumber(latest.payload.attemptCount, MAX_ATTEMPTS)));
  const nextRetryAt = terminal || status !== "RETRYABLE"
    ? null
    : typeof latest.payload.nextRetryAt === "string" && Number.isFinite(Date.parse(latest.payload.nextRetryAt))
      ? latest.payload.nextRetryAt
      : null;
  return {
    normalizedUrl: typeof latest.payload.normalizedUrl === "string" ? latest.payload.normalizedUrl : key.normalizedUrl,
    urlHash: key.urlHash,
    sourceId: input.sourceId,
    categoryId: input.categoryId,
    failureKind: readFailureKind(latest.payload.failureKind),
    attemptCount,
    nextRetryAt,
    httpStatus: typeof latest.payload.httpStatus === "number" ? latest.payload.httpStatus : null,
    retryAfterMs: typeof latest.payload.retryAfterMs === "number" ? latest.payload.retryAfterMs : null,
    redirectCount: readNumber(latest.payload.redirectCount, 10),
    lastFailureAt: typeof latest.payload.lastFailureAt === "string" ? latest.payload.lastFailureAt : "",
    terminalAt: typeof latest.payload.terminalAt === "string" ? latest.payload.terminalAt : null,
    status,
  };
};

export async function getRedirectRetryState(input: {
  sourceId: string;
  categoryId: string | null;
  url: string;
  /** Explicit admin reprocessing may bypass only terminal URL state. */
  bypassTerminal?: boolean;
}): Promise<RedirectRetryState | null> {
  const key = buildRedirectRetryKey(input.url);
  if (!key || !prisma.pipelineArtifact?.findMany) return null;
  try {
    const latest = await findLatestState(input.sourceId, input.categoryId, key.urlHash);
    if (!latest) return null;
    const state = stateFromArtifact(latest, input, key);
    if (!state) return null;
    if (state.status === "RETRYABLE" && (!state.nextRetryAt || Date.parse(state.nextRetryAt) <= Date.now())) {
      return null;
    }
    if (input.bypassTerminal && terminalStatuses.has(state.status)) return null;
    return state;
  } catch {
    return null;
  }
}

export async function recordRedirectRetryState(input: {
  pipelineRunId?: string;
  sourceId: string;
  categoryId: string | null;
  originalUrl: string;
  evidence: SafeRedirectEvidence;
  /** Explicit reprocessing may supersede a previous terminal artifact. */
  bypassTerminal?: boolean;
}): Promise<RedirectRetryState | null> {
  if (!input.pipelineRunId || !prisma.pipelineArtifact?.create) return null;
  const key = buildRedirectRetryKey(input.originalUrl);
  if (!key || !input.evidence.failureKind) return null;
  try {
    const prior = await findLatestState(input.sourceId, input.categoryId, key.urlHash);
    const priorStatus = prior ? readStatus(prior.status) || readStatus(prior.payload.status) : null;
    if (priorStatus && terminalStatuses.has(priorStatus) && !input.bypassTerminal && prior) return stateFromArtifact(
      prior,
      { sourceId: input.sourceId, categoryId: input.categoryId },
      key,
    );

    const isTerminal = input.evidence.failureKind === "security_rejected" || input.evidence.failureKind === "invalid_redirect";
    const priorAttempts = prior && typeof prior.payload.attemptCount === "number" ? prior.payload.attemptCount : 0;
    const attemptCount = isTerminal
      ? Math.min(MAX_ATTEMPTS, Math.max(1, Math.round(priorAttempts) + 1))
      : Math.min(MAX_ATTEMPTS, Math.max(1, Math.round(priorAttempts) + 1));
    const failureKind = input.evidence.failureKind;
    const retryAfterMs = input.evidence.retryAfterMs ?? null;
    const exhausted = !isTerminal && attemptCount >= MAX_ATTEMPTS;
    const status: RedirectArtifactStatus = isTerminal
      ? failureKind === "security_rejected" ? "SECURITY_REJECTED" : "INVALID_REDIRECT"
      : exhausted ? "EXHAUSTED" : "RETRYABLE";
    const now = new Date().toISOString();
    const nextRetryAt = status === "RETRYABLE"
      ? new Date(Date.now() + retryDelay(failureKind, retryAfterMs)).toISOString()
      : null;
    const state: RedirectRetryState = {
      ...key,
      sourceId: input.sourceId,
      categoryId: input.categoryId,
      failureKind,
      attemptCount,
      nextRetryAt,
      httpStatus: input.evidence.httpStatus,
      retryAfterMs,
      redirectCount: Math.min(10, Math.max(0, input.evidence.redirectCount)),
      lastFailureAt: now,
      terminalAt: status === "RETRYABLE" ? null : now,
      status,
    };
    await prisma.pipelineArtifact.create({
      data: {
        pipelineRunId: input.pipelineRunId,
        sourceId: input.sourceId,
        categoryId: input.categoryId,
        artifactType: REDIRECT_RETRY_ARTIFACT_TYPE,
        status: state.status,
        candidateCount: 0,
        payload: {
          normalizedUrl: sanitizeRedirectUrl(input.originalUrl),
          urlHash: state.urlHash,
          sourceId: state.sourceId,
          categoryId: state.categoryId,
          failureKind: state.failureKind,
          attemptCount: state.attemptCount,
          nextRetryAt: state.nextRetryAt,
          httpStatus: state.httpStatus,
          retryAfterMs: state.retryAfterMs,
          redirectCount: state.redirectCount,
          lastFailureAt: state.lastFailureAt,
          terminalAt: state.terminalAt,
          status: state.status,
        },
        errorLog: boundedString(
          status === "RETRYABLE"
            ? `Redirect ${failureKind} deferred until ${nextRetryAt}.`
            : `Redirect ${failureKind} entered terminal state ${status}.`,
          300,
        ),
      },
    });
    return state;
  } catch {
    return null;
  }
}

export async function resolveRedirectRetryState(input: {
  pipelineRunId?: string;
  sourceId: string;
  categoryId: string | null;
  originalUrl: string;
  /** Explicit reprocessing may close a terminal artifact after success. */
  bypassTerminal?: boolean;
}) {
  if (!prisma.pipelineArtifact?.findMany) return;
  const key = buildRedirectRetryKey(input.originalUrl);
  if (!key) return;
  try {
    const latest = await findLatestState(input.sourceId, input.categoryId, key.urlHash);
    if (!latest) return;
    const status = readStatus(latest.status) || readStatus(latest.payload.status);
    if (status !== "RETRYABLE" && !(input.bypassTerminal && status && terminalStatuses.has(status))) return;
    await prisma.pipelineArtifact.updateMany({
      where: { id: latest.id, status: latest.status },
      data: {
        status: "RESOLVED",
        payload: { ...latest.payload, status: "RESOLVED", nextRetryAt: null, resolvedAt: new Date().toISOString() },
      },
    });
  } catch {
    // Diagnostics must never fail successful ingest.
  }
}

export { MAX_ATTEMPTS };
