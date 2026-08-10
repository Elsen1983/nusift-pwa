import { prisma } from "../prisma";
import {
  ARTICLE_ACCESS_DETECTOR_VERSION,
  classifyArticleAccess,
  type ArticleAccessClassification,
} from "./article-access-classification";
import {
  sanitizeEnrichmentEvidenceText,
  sanitizeEnrichmentEvidenceUrl,
  type ArticleAccessOutcomeSummary,
} from "./enrichment";
import { hasUsableAgent3BodyText } from "./publication-gate";

export const PAYWALL_REPAIR_CONFIRMATION = "APPLY_PAYWALL_CLASSIFICATION_REPAIR";
export const PAYWALL_REPAIR_PRODUCTION_CONFIRMATION = "PRODUCTION_PAYWALL_CLASSIFICATION_REPAIR";
export const DEFAULT_PAYWALL_REPAIR_LIMIT = 100;
export const MAX_PAYWALL_REPAIR_LIMIT = 200;
export const MAX_REPAIR_ARTIFACTS_PER_SOURCE = 100;
export const PAYWALL_REPAIR_QUERY_CONCURRENCY = 4;
export const PAYWALL_REPAIR_ARTIFACT_TYPE = "paywall_classification_repair";

const ACCESS_CLASSIFICATIONS = new Set<ArticleAccessClassification>([
  "ACCESSIBLE",
  "PAYWALL_BLOCKED",
  "METERED_OR_DECLARED",
  "INTERSTITIAL_OR_CHALLENGE",
  "HTTP_ACCESS_BLOCKED",
  "UNKNOWN",
]);

const SUCCESSFUL_ENRICHMENT_STATUSES = new Set(["ENRICHED"]);
const ARTIFACT_TYPES = [
  "article_enrichment_result",
  "article_enrichment_rejection",
  "article_headless_queue_candidate",
  PAYWALL_REPAIR_ARTIFACT_TYPE,
] as const;

/** Only exact Agent 3 enrichment outcomes can authorize automatic repair. */
/** Only these exact enrichment artifacts can authorize repair or fail closed as malformed access evidence. */
const AUTHORITATIVE_ARTIFACT_TYPES: ReadonlySet<string> = new Set([
  "article_enrichment_result",
  "article_enrichment_rejection",
]);

// Prisma schema changes are intentionally out of scope. This process-local
// lock closes the remaining concurrent-apply race for workers sharing a
// process; the optimistic Article predicate remains the cross-process guard.
const activeRepairArticleIds = new Set<number>();

type PlainObject = Record<string, unknown>;

export type PaywallRepairArticle = {
  id: number;
  sourceId: string;
  categoryId: string | null;
  title: string;
  canonicalUrl: string | null;
  sourceUrl: string | null;
  bodyText: string | null;
  isPaywall: boolean;
  enrichmentStatus: string;
  enrichmentOutcome: unknown;
  updatedAt: Date;
};

type PaywallRepairArtifact = {
  id: string;
  sourceId: string | null;
  categoryId: string | null;
  artifactType: string;
  status: string;
  createdAt: Date;
  payload: unknown;
};

type AccessSnapshot = {
  access: ArticleAccessOutcomeSummary;
  /** Null for the Article-summary fallback; it is never used for freshness ordering. */
  createdAt: Date | null;
  artifactId: string;
  artifactType: string | null;
  source: "article_outcome" | "artifact";
};

type SourceEvidenceWindow = {
  artifacts: PaywallRepairArtifact[];
  truncated: boolean;
  queryFailed: boolean;
  /** Article ids with a durable repair artifact; prevents duplicate applies. */
  appliedRepairArticleIds?: Set<number>;
  /** Exact article matches whose access payload was malformed or missing. */
  malformedEvidenceArticleIds?: Set<number>;
};

export type PaywallRepairDb = {
  article: {
    findMany: (args: unknown) => Promise<PaywallRepairArticle[]>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  pipelineArtifact: {
    findMany: (args: unknown) => Promise<PaywallRepairArtifact[]>;
    create: (args: unknown) => Promise<unknown>;
  };
  pipelineRun: {
    create: (args: unknown) => Promise<{ id: string }>;
    update?: (args: unknown) => Promise<unknown>;
  };
  $transaction: <T>(callback: (tx: PaywallRepairDb) => Promise<T>) => Promise<T>;
};

export type PaywallRepairEnvironment = {
  [key: string]: string | undefined;
  NODE_ENV?: string;
  DATABASE_URL?: string;
  PAYWALL_REPAIR_ALLOW_PRODUCTION?: string;
};

export type PaywallRepairExecutionOptions = {
  apply?: boolean;
  confirmation?: string;
  production?: boolean;
  productionConfirmation?: string;
  limit?: number;
  sourceId?: string;
  /** Testable environment override; the CLI uses process.env. */
  environment?: PaywallRepairEnvironment;
};

export type PaywallRepairDecision =
  | "LIKELY_FALSE_POSITIVE"
  | "CONFIRMED_BLOCKING_PAYWALL"
  | "DECLARED_OR_METERED"
  | "UNKNOWN"
  | "SKIPPED";

export type PaywallRepairArticleSnapshot = Pick<
  PaywallRepairArticle,
  "id" | "sourceId" | "categoryId" | "title" | "canonicalUrl" | "sourceUrl" | "isPaywall" | "enrichmentStatus" | "updatedAt"
>;

export type PaywallRepairAssessment = {
  /** Redacted report-safe snapshot; bodyText and enrichmentOutcome never escape. */
  article: PaywallRepairArticleSnapshot;
  decision: PaywallRepairDecision;
  currentClassification: ArticleAccessClassification;
  proposedClassification: ArticleAccessClassification;
  proposedIsPaywall: boolean | null;
  repairEligible: boolean;
  detectorVersion: string;
  detectorVersionMismatch: boolean;
  evidenceCodes: string[];
  contradictingEvidenceCodes: string[];
  reason: string;
  sanitizedSample: {
    articleId: number;
    sourceId: string;
    title: string | null;
    canonicalUrl: string | null;
  };
  currentAccess: ArticleAccessOutcomeSummary | null;
  /** Latest bounded diagnostic evidence, including Agent 1/2 evidence, without authorizing repair. */
  diagnosticAccess: ArticleAccessOutcomeSummary | null;
  diagnosticArtifactId: string | null;
  latestArtifactId: string | null;
  selectedEvidenceSource: "article_outcome" | "artifact" | null;
  selectedEvidenceArtifactId: string | null;
  artifactWindowTruncated: boolean;
  previousOutcomeKind: string | null;
};

export type PaywallRepairReport = {
  dryRun: boolean;
  applyRequested: boolean;
  inspectedCount: number;
  likelyFalsePositives: number;
  confirmedBlockingPaywalls: number;
  declaredMeteredCases: number;
  unknownCases: number;
  skippedCases: number;
  detectorVersionMismatchCount: number;
  truncatedSourceCount: number;
  articlesFromTruncatedSources: number;
  appliedCount: number;
  concurrentChangeCount: number;
  failedCount: number;
  artifactCount: number;
  bySource: Record<string, {
    inspected: number;
    likelyFalsePositives: number;
    confirmedBlockingPaywalls: number;
    declaredMeteredCases: number;
    unknownCases: number;
    skippedCases: number;
  }>;
  samples: Array<{
    articleId: number;
    sourceId: string;
    title: string | null;
    proposed: string;
    oldIsPaywall: boolean;
    newIsPaywall: boolean | null;
    evidenceCodes: string[];
    diagnosticSourceStage: ArticleAccessOutcomeSummary["sourceStage"] | null;
    diagnosticArtifactId: string | null;
    diagnosticEvidenceCodes: string[];
    reason: string;
  }>;
  assessments: PaywallRepairAssessment[];
};

const isPlainObject = (value: unknown): value is PlainObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asClassification = (value: unknown): ArticleAccessClassification | null =>
  typeof value === "string" && ACCESS_CLASSIFICATIONS.has(value as ArticleAccessClassification)
    ? value as ArticleAccessClassification
    : null;

const sanitizeBoundedCodeArray = (input: unknown): string[] => Array.isArray(input)
  ? input
    .map((entry) => sanitizeEnrichmentEvidenceText(entry, 80))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 12)
  : [];

const asAccessSummary = (value: unknown): ArticleAccessOutcomeSummary | null => {
  if (!isPlainObject(value)) return null;
  const classification = asClassification(value.classification);
  // A persisted access summary is only usable when its bounded shape is
  // complete. Missing evidence fields are not treated as harmless defaults:
  // repair must fail closed rather than turn a malformed record into proof of
  // accessibility.
  if (!classification
    || !Array.isArray(value.evidenceCodes)
    || !Array.isArray(value.contradictingEvidenceCodes)
    || typeof value.evidenceArticleScoped !== "boolean"
    || typeof value.usableBodyExtracted !== "boolean"
    || typeof value.bodyTruncationDetected !== "boolean"
    || typeof value.articleScopedGateOrOverlayDetected !== "boolean"
    || typeof value.decisive !== "boolean") return null;
  const sourceStage = value.sourceStage === "agent1" || value.sourceStage === "agent2" || value.sourceStage === "agent3"
    ? value.sourceStage
    : null;
  const confidence = value.confidence === "HIGH" || value.confidence === "MEDIUM" || value.confidence === "LOW"
    ? value.confidence
    : null;
  const detectorVersion = sanitizeEnrichmentEvidenceText(value.detectorVersion, 80);
  if (!sourceStage || !confidence || !detectorVersion) return null;
  return {
    classification,
    sourceStage,
    confidence,
    detectorVersion,
    evidenceCodes: sanitizeBoundedCodeArray(value.evidenceCodes),
    contradictingEvidenceCodes: sanitizeBoundedCodeArray(value.contradictingEvidenceCodes),
    evidenceArticleScoped: value.evidenceArticleScoped === true,
    usableBodyExtracted: value.usableBodyExtracted === true,
    bodyTruncationDetected: value.bodyTruncationDetected === true,
    articleScopedGateOrOverlayDetected: value.articleScopedGateOrOverlayDetected === true,
    decisive: value.decisive === true,
    previousIsPaywall: value.previousIsPaywall === true,
    earlyStageClassification: asClassification(value.earlyStageClassification),
    earlyStageSource: value.earlyStageSource === "agent1" || value.earlyStageSource === "agent2" ? value.earlyStageSource : null,
    earlyStageEvidenceCodes: sanitizeBoundedCodeArray(value.earlyStageEvidenceCodes),
    earlyStageContradictingEvidenceCodes: sanitizeBoundedCodeArray(value.earlyStageContradictingEvidenceCodes),
    finalIsPaywall: typeof value.finalIsPaywall === "boolean" ? value.finalIsPaywall : null,
    overrideReason: sanitizeEnrichmentEvidenceText(value.overrideReason, 240),
  };
};

const readOutcomeRecord = (value: unknown): PlainObject | null => isPlainObject(value) ? value : null;

const readArticleAccess = (article: PaywallRepairArticle): ArticleAccessOutcomeSummary | null =>
  asAccessSummary(readOutcomeRecord(article.enrichmentOutcome)?.access);

const readArtifactAccess = (artifact: PaywallRepairArtifact, articleId: number): AccessSnapshot | null => {
  const payload = isPlainObject(artifact.payload) ? artifact.payload : null;
  if (payload?.articleId !== articleId) return null;
  const access = asAccessSummary(payload.access);
  return access
    ? { access, createdAt: artifact.createdAt, artifactId: artifact.id, artifactType: artifact.artifactType, source: "artifact" }
    : null;
};

const hasMalformedArticleEvidence = (artifact: PaywallRepairArtifact, articleId: number): boolean => {
  if (!AUTHORITATIVE_ARTIFACT_TYPES.has(artifact.artifactType)) return false;
  const payload = isPlainObject(artifact.payload) ? artifact.payload : null;
  return payload?.articleId === articleId && asAccessSummary(payload.access) === null;
};

const artifactTime = (snapshot: AccessSnapshot): number => snapshot.createdAt?.getTime() ?? 0;

const compareSnapshots = (a: AccessSnapshot, b: AccessSnapshot): number => {
  const byTime = artifactTime(b) - artifactTime(a);
  if (byTime !== 0) return byTime;
  return String(b.artifactId).localeCompare(String(a.artifactId));
};

const boundedCodes = (codes: string[]): string[] => codes
  .map((code) => sanitizeEnrichmentEvidenceText(code, 80))
  .filter((code): code is string => Boolean(code))
  .slice(0, 12);

const SENSITIVE_DIAGNOSTIC_KEYS = new Set([
  "body",
  "bodyText",
  "bodyHtml",
  "html",
  "rawHtml",
  "fullArticleText",
  "content",
]);

const sanitizeBoundedDiagnostic = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return null;
  if (typeof value === "string") return sanitizeEnrichmentEvidenceText(value, 240);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((entry) => sanitizeBoundedDiagnostic(entry, depth + 1));
  if (!isPlainObject(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_DIAGNOSTIC_KEYS.has(key))
      .slice(0, 24)
      .map(([key, entry]) => [
        sanitizeEnrichmentEvidenceText(key, 80) ?? "field",
        sanitizeBoundedDiagnostic(entry, depth + 1),
      ]),
  );
};

const buildClassifierInput = (
  article: PaywallRepairArticle,
  access: ArticleAccessOutcomeSummary | null,
): Parameters<typeof classifyArticleAccess>[0] => {
  const bodyText = article.bodyText;
  const evidenceCodes = access?.evidenceCodes ?? [];
  const articleScopedCtaTexts = evidenceCodes.includes("article_scoped_cta")
    ? ["Subscribe to continue reading this article."]
    : [];
  const jsonLdPaywallSignals = evidenceCodes.includes("jsonld_declared_paywall")
    ? [{ code: "isAccessibleForFree:false" as const, nodeType: "NewsArticle", nodeIdentityState: "matched" as const }]
    : [];
  const challengeTextSignals = access?.classification === "INTERSTITIAL_OR_CHALLENGE"
    ? ["interstitial_challenge"]
    : [];
  return {
    statusCode: 200,
    bodyText,
    usableBodyExtracted: hasUsableAgent3BodyText(bodyText),
    bodyTruncationDetected: access?.bodyTruncationDetected === true,
    rawPageText: (bodyText ?? "").slice(0, 100_000),
    articleScopedGateOrOverlayDetected: access?.articleScopedGateOrOverlayDetected === true
      || evidenceCodes.includes("article_scoped_gate_or_overlay"),
    articleScopedCtaTexts,
    jsonLdPaywallSignals,
    challengeTextSignals,
  };
};

const mergeAccessSnapshots = (
  article: PaywallRepairArticle,
  snapshots: AccessSnapshot[],
): {
  latest: AccessSnapshot | null;
  authority: AccessSnapshot | null;
  conflict: boolean;
} => {
  // Only exact per-article Agent 3 artifacts are authoritative when present.
  // Agent 1/2 artifacts remain available to diagnostics but can never authorize
  // an automatic Article mutation.
  const artifactSnapshots = snapshots
    .filter((snapshot) => snapshot.source === "artifact")
    .sort(compareSnapshots);
  const latest = artifactSnapshots[0] ?? (() => {
    const articleAccess = readArticleAccess(article);
    return articleAccess
      ? {
          access: articleAccess,
          createdAt: null,
          artifactId: `article-${article.id}`,
          artifactType: null,
          source: "article_outcome" as const,
        }
      : null;
  })();

  const authoritativeArtifacts = artifactSnapshots
    .filter((snapshot) => snapshot.access.sourceStage === "agent3")
    .filter((snapshot) => AUTHORITATIVE_ARTIFACT_TYPES.has(snapshot.artifactType ?? ""));
  if (authoritativeArtifacts.length > 0) {
    const authority = authoritativeArtifacts[0]!;
    // Conflicts are checked only among authoritative artifacts at the newest
    // artifact timestamp. Artifact IDs provide deterministic ordering when
    // timestamps tie, but disagreement still fails closed.
    const sameTimestamp = authoritativeArtifacts.filter(
      (entry) => artifactTime(entry) === artifactTime(authority),
    );
    const conflict = new Set(sameTimestamp.map((entry) => entry.access.classification)).size > 1;
    return { latest, authority, conflict };
  }

  // The Article summary is an authority fallback only when no valid exact
  // Agent 3 artifact exists. Its updatedAt is application-wide metadata, not
  // access-evidence freshness, so it is never compared with artifact dates.
  const articleAccess = readArticleAccess(article);
  const authority = articleAccess?.sourceStage === "agent3"
    ? {
        access: articleAccess,
        createdAt: null,
        artifactId: `article-${article.id}`,
        artifactType: null,
        source: "article_outcome" as const,
      }
    : null;
  return { latest, authority, conflict: false };
};

const makeSample = (article: PaywallRepairArticle) => ({
  articleId: article.id,
  sourceId: sanitizeEnrichmentEvidenceText(article.sourceId, 120) ?? "unknown",
  title: sanitizeEnrichmentEvidenceText(article.title, 180),
  canonicalUrl: sanitizeEnrichmentEvidenceUrl(article.canonicalUrl ?? article.sourceUrl),
});

export function validatePaywallRepairExecution(
  options: PaywallRepairExecutionOptions,
  env: PaywallRepairEnvironment = process.env,
): { apply: boolean; production: boolean; limit: number } {
  const apply = options.apply === true;
  const production = options.production === true || env.NODE_ENV === "production";
  const limit = Math.min(Math.max(Math.round(options.limit ?? DEFAULT_PAYWALL_REPAIR_LIMIT), 1), MAX_PAYWALL_REPAIR_LIMIT);

  if (apply && options.confirmation !== PAYWALL_REPAIR_CONFIRMATION) {
    throw new Error(`Apply mode requires the exact confirmation token ${PAYWALL_REPAIR_CONFIRMATION}.`);
  }
  if (production) {
    if (options.production !== true || options.productionConfirmation !== PAYWALL_REPAIR_PRODUCTION_CONFIRMATION) {
      throw new Error("Production mode requires --production and the separate production confirmation token.");
    }
    if (env.PAYWALL_REPAIR_ALLOW_PRODUCTION !== "true") {
      throw new Error("Production mode requires PAYWALL_REPAIR_ALLOW_PRODUCTION=true; no production operation was performed.");
    }
  }

  const databaseUrl = env.DATABASE_URL;
  if (apply && !databaseUrl) {
    throw new Error("Apply mode requires DATABASE_URL; no repair was performed.");
  }
  if (databaseUrl) {
    try {
      const hostname = new URL(databaseUrl).hostname.toLowerCase();
      const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
      if (apply && !local && !production) {
        throw new Error("Apply mode refuses non-local databases unless explicit production mode is enabled.");
      }
      if (!apply && !local && !production) {
        throw new Error("Non-local audit requires explicit production mode; commented environment values are never inspected.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("mode refuses")) throw error;
      if (error instanceof Error && error.message.includes("Non-local audit")) throw error;
      throw new Error("DATABASE_URL must be a valid URL for paywall repair safety checks.");
    }
  }
  return { apply, production, limit };
}

async function loadSourceEvidence(
  db: PaywallRepairDb,
  sourceId: string,
): Promise<SourceEvidenceWindow> {
  try {
    const rows = await db.pipelineArtifact.findMany({
      where: {
        sourceId,
        artifactType: { in: [...ARTIFACT_TYPES] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_REPAIR_ARTIFACTS_PER_SOURCE + 1,
      select: { id: true, sourceId: true, categoryId: true, artifactType: true, status: true, createdAt: true, payload: true },
    });
    const retained = rows.slice(0, MAX_REPAIR_ARTIFACTS_PER_SOURCE);
    const appliedRepairArticleIds = new Set<number>();
    for (const artifact of retained) {
      if (artifact.artifactType !== PAYWALL_REPAIR_ARTIFACT_TYPE || !isPlainObject(artifact.payload)) continue;
      const articleId = artifact.payload.articleId;
      if (typeof articleId === "number" && Number.isSafeInteger(articleId) && articleId > 0) {
        appliedRepairArticleIds.add(articleId);
      }
    }
    return {
      artifacts: retained,
      truncated: rows.length > MAX_REPAIR_ARTIFACTS_PER_SOURCE,
      queryFailed: false,
      appliedRepairArticleIds,
      malformedEvidenceArticleIds: new Set(
        retained
          .filter((artifact) => isPlainObject(artifact.payload) && typeof artifact.payload.articleId === "number")
          .filter((artifact) => hasMalformedArticleEvidence(artifact, (artifact.payload as PlainObject).articleId as number))
          .map((artifact) => (artifact.payload as PlainObject).articleId as number),
      ),
    };
  } catch {
    return {
      artifacts: [],
      truncated: false,
      queryFailed: true,
      appliedRepairArticleIds: new Set(),
      malformedEvidenceArticleIds: new Set(),
    };
  }
}

async function loadEvidenceWindows(
  db: PaywallRepairDb,
  sourceIds: string[],
): Promise<Map<string, SourceEvidenceWindow>> {
  const windows = new Map<string, SourceEvidenceWindow>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= sourceIds.length) return;
      const sourceId = sourceIds[index]!;
      windows.set(sourceId, await loadSourceEvidence(db, sourceId));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAYWALL_REPAIR_QUERY_CONCURRENCY, sourceIds.length) }, () => worker()));
  return windows;
}

export function assessPaywallRepair(
  article: PaywallRepairArticle,
  sourceWindow: SourceEvidenceWindow,
): PaywallRepairAssessment {
  const snapshots = sourceWindow.artifacts
    .map((artifact) => readArtifactAccess(artifact, article.id))
    .filter((snapshot): snapshot is AccessSnapshot => Boolean(snapshot));
  const { latest, authority, conflict } = mergeAccessSnapshots(article, snapshots);
  // `currentAccess` is the authority used for classification and mutation.
  // `diagnosticAccess` deliberately retains the latest bounded Agent 1/2
  // evidence so dry-run reports do not hide early-stage provenance.
  const currentAccess = authority?.access ?? null;
  const diagnosticAccess = latest?.access ?? null;
  const rawArticleAccess = readOutcomeRecord(article.enrichmentOutcome)?.access;
  const malformedArticleEvidence = rawArticleAccess !== undefined && asAccessSummary(rawArticleAccess) === null;
  // Keep the fail-closed guarantee in the assessment boundary as well as the
  // database loader: direct callers must not bypass malformed authoritative
  // enrichment-artifact detection and fall back to a less authoritative
  // Article summary. Queue and repair artifacts remain diagnostic-only and are
  // intentionally ignored by this malformed-evidence guard.
  const malformedExactArtifact = sourceWindow.artifacts.some((artifact) => {
    if (!AUTHORITATIVE_ARTIFACT_TYPES.has(artifact.artifactType)) return false;
    const payload = isPlainObject(artifact.payload) ? artifact.payload : null;
    return payload?.articleId === article.id && asAccessSummary(payload.access) === null;
  });
  const currentClassification = currentAccess?.classification ?? "UNKNOWN";
  const alreadyApplied = sourceWindow.appliedRepairArticleIds?.has(article.id) === true;
  const malformedEvidence = sourceWindow.malformedEvidenceArticleIds?.has(article.id) === true
    || malformedExactArtifact;
  const detectorVersion = currentAccess?.detectorVersion || "missing";
  const detectorVersionMismatch = detectorVersion !== ARTICLE_ACCESS_DETECTOR_VERSION;
  const evidenceCodes = boundedCodes(currentAccess?.evidenceCodes ?? []);
  const contradictingEvidenceCodes = boundedCodes(currentAccess?.contradictingEvidenceCodes ?? []);
  const classifier = classifyArticleAccess(buildClassifierInput(article, currentAccess));
  const outcomeKind = readOutcomeRecord(article.enrichmentOutcome)?.kind;
  // A partially successful Agent 3 attempt may have retained a substantial
  // body while ending in LOW_CONTENT_QUALITY. It is eligible for reclassification
  // only when the body itself passes the same substantial-body boundary.
  const substantialBody = hasUsableAgent3BodyText(article.bodyText);
  // Repair only coherent persisted enrichment states. The repair changes
  // access classification, not the enrichment lifecycle state:
  //   SUCCESS + ENRICHED           -> preserve SUCCESS and ENRICHED
  //   LOW_CONTENT_QUALITY + FAILED -> preserve LOW_CONTENT_QUALITY and FAILED
  // A PAYWALL_BLOCKED outcome kind is deliberately not rewritten: changing its
  // access label without a coupled enrichment transition would create an
  // ambiguous or internally inconsistent durable state, so it fails closed.
  const stalePaywallOutcome = outcomeKind === "PAYWALL_BLOCKED";
  const success = (
    SUCCESSFUL_ENRICHMENT_STATUSES.has(article.enrichmentStatus)
      && outcomeKind === "SUCCESS"
  ) || (
    article.enrichmentStatus === "ENRICHMENT_FAILED"
      && outcomeKind === "LOW_CONTENT_QUALITY"
      && substantialBody
  );
  // The selected Agent 3 access evidence is authoritative for this repair
  // assessment. A PAYWALL_BLOCKED outcome kind is handled separately above:
  // without a coupled lifecycle transition, rewriting it would risk an
  // internally inconsistent durable state. Genuine gates remain protected by
  // `gate`, CTA reconstruction, or the selected classification.
  // Preserve an authoritative blocking classification even when a substantial
  // stored body lets the compatibility classifier reconstruct a softer result.
  // An exact Agent 3 PAYWALL_BLOCKED artifact must not be cleared by a newer
  // Article summary or by Article.updatedAt metadata.
  const confirmedBlock = currentClassification === "PAYWALL_BLOCKED"
    || classifier.classification === "PAYWALL_BLOCKED";
  const declared = currentClassification === "METERED_OR_DECLARED" || classifier.classification === "METERED_OR_DECLARED";
  const gate = currentAccess?.articleScopedGateOrOverlayDetected === true
    || classifier.articleScopedGateOrOverlayDetected;
  const authoritativeAgent3Evidence = currentAccess?.sourceStage === "agent3";
  const reasonBase = sourceWindow.queryFailed
    ? "Artifact evidence query failed; no repair is safe."
    : alreadyApplied
      ? "A durable repair artifact already exists; repeated apply is idempotently skipped."
      : malformedEvidence || malformedArticleEvidence
        ? "Matching persisted access evidence is malformed or missing; no automatic repair is safe."
        : conflict
        ? "Conflicting Agent 3 evidence exists at the newest artifact timestamp; no repair is safe."
        : !authoritativeAgent3Evidence
          ? "Automatic repair requires authoritative Agent 3 access evidence."
          : currentAccess?.classification === "UNKNOWN"
            ? "The persisted access classification is UNKNOWN; no automatic repair is safe."
            : stalePaywallOutcome
        ? "The persisted outcome kind is PAYWALL_BLOCKED; no uncoupled state transition is safe."
        : !success
        ? "Agent 3 did not persist a coherent repairable enrichment outcome."
        : !substantialBody
          ? "Stored body is below the substantial-body threshold."
          : confirmedBlock
            ? "Confirmed article access-blocking evidence remains."
            : gate
              ? "An article-scoped gate or overlay remains unresolved."
              : declared
                ? "Declared or metered access is readable but is not an automatic ACCESSIBLE repair."
                : classifier.classification === "UNKNOWN"
                  ? "Classifier could not establish a decisive access state."
                  : "";
  const repairEligible = !sourceWindow.queryFailed
    && !sourceWindow.truncated
    && !alreadyApplied
    && !malformedEvidence
    && !malformedArticleEvidence
    && !conflict
    && !stalePaywallOutcome
    && authoritativeAgent3Evidence
    && Boolean(currentAccess)
    && currentAccess?.classification !== "UNKNOWN"
    && success
    && substantialBody
    && !confirmedBlock
    && !gate
    && classifier.classification === "ACCESSIBLE"
    && classifier.confidence === "HIGH"
    && !declared;
  // A selected authoritative PAYWALL_BLOCKED access result remains visible as
  // a confirmed block even when its lifecycle kind is PAYWALL_BLOCKED; it is
  // never repair-eligible. A stale lifecycle label without blocking access
  // evidence is skipped rather than being reinterpreted.
  const decision: PaywallRepairDecision = repairEligible
    ? "LIKELY_FALSE_POSITIVE"
    : conflict
      ? "SKIPPED"
      : confirmedBlock
        ? "CONFIRMED_BLOCKING_PAYWALL"
        : stalePaywallOutcome
        ? "SKIPPED"
        : declared
          ? "DECLARED_OR_METERED"
    : !success || stalePaywallOutcome || !substantialBody || sourceWindow.queryFailed || sourceWindow.truncated || alreadyApplied || malformedEvidence || malformedArticleEvidence || gate || conflict || !authoritativeAgent3Evidence || currentAccess?.classification === "UNKNOWN"
      ? "SKIPPED"
          : "UNKNOWN";
  const reason = repairEligible
    ? "High-confidence ACCESSIBLE body with no article-scoped gate, blocking evidence, or unresolved conflict."
    : reasonBase || "Automatic repair criteria were not all satisfied.";

  const reportArticle: PaywallRepairArticleSnapshot = {
    id: article.id,
    sourceId: sanitizeEnrichmentEvidenceText(article.sourceId, 120) ?? "unknown",
    categoryId: sanitizeEnrichmentEvidenceText(article.categoryId, 120),
    title: sanitizeEnrichmentEvidenceText(article.title, 180) ?? "",
    canonicalUrl: sanitizeEnrichmentEvidenceUrl(article.canonicalUrl),
    sourceUrl: sanitizeEnrichmentEvidenceUrl(article.sourceUrl),
    isPaywall: article.isPaywall,
    enrichmentStatus: article.enrichmentStatus,
    updatedAt: article.updatedAt,
  };

  return {
    article: reportArticle,
    decision,
    currentClassification,
    proposedClassification: repairEligible ? "ACCESSIBLE" : currentClassification,
    proposedIsPaywall: repairEligible ? false : article.isPaywall,
    repairEligible,
    detectorVersion: ARTICLE_ACCESS_DETECTOR_VERSION,
    detectorVersionMismatch,
    evidenceCodes,
    contradictingEvidenceCodes,
    reason,
    sanitizedSample: makeSample(article),
    currentAccess,
    diagnosticAccess,
    diagnosticArtifactId: latest?.source === "artifact" ? latest.artifactId : null,
    latestArtifactId: authority?.source === "artifact" ? authority.artifactId : null,
    selectedEvidenceSource: authority?.source ?? null,
    selectedEvidenceArtifactId: authority?.source === "artifact" ? authority.artifactId : null,
    artifactWindowTruncated: sourceWindow.truncated,
    previousOutcomeKind: typeof outcomeKind === "string" ? outcomeKind : null,
  };
}

const emptySourceSummary = () => ({
  inspected: 0,
  likelyFalsePositives: 0,
  confirmedBlockingPaywalls: 0,
  declaredMeteredCases: 0,
  unknownCases: 0,
  skippedCases: 0,
});

const incrementReport = (
  report: PaywallRepairReport,
  assessment: PaywallRepairAssessment,
): void => {
  const source = sanitizeEnrichmentEvidenceText(assessment.article.sourceId, 120) ?? "unknown";
  const summary = report.bySource[source] ?? (report.bySource[source] = emptySourceSummary());
  summary.inspected += 1;
  if (assessment.decision === "LIKELY_FALSE_POSITIVE") {
    report.likelyFalsePositives += 1;
    summary.likelyFalsePositives += 1;
  } else if (assessment.decision === "CONFIRMED_BLOCKING_PAYWALL") {
    report.confirmedBlockingPaywalls += 1;
    summary.confirmedBlockingPaywalls += 1;
  } else if (assessment.decision === "DECLARED_OR_METERED") {
    report.declaredMeteredCases += 1;
    summary.declaredMeteredCases += 1;
  } else if (assessment.decision === "UNKNOWN") {
    report.unknownCases += 1;
    summary.unknownCases += 1;
  } else {
    report.skippedCases += 1;
    summary.skippedCases += 1;
  }
  if (assessment.detectorVersionMismatch) report.detectorVersionMismatchCount += 1;
  if (report.samples.length < 20) {
    report.samples.push({
      articleId: assessment.article.id,
      sourceId: sanitizeEnrichmentEvidenceText(assessment.article.sourceId, 120) ?? "unknown",
      title: assessment.sanitizedSample.title,
      proposed: `${assessment.currentClassification}->${assessment.proposedClassification}`,
      oldIsPaywall: assessment.article.isPaywall,
      newIsPaywall: assessment.proposedIsPaywall,
      // Include bounded diagnostic evidence in dry-run samples. Authority
      // remains separately enforced by `currentAccess` and repairEligible.
      evidenceCodes: assessment.evidenceCodes,
      diagnosticSourceStage: assessment.diagnosticAccess?.sourceStage ?? null,
      diagnosticArtifactId: assessment.diagnosticArtifactId,
      diagnosticEvidenceCodes: boundedCodes(assessment.diagnosticAccess?.evidenceCodes ?? []),
      reason: assessment.reason,
    });
  }
};

const buildReport = (input: PaywallRepairExecutionOptions, normalized: { apply: boolean; production: boolean; limit: number }): PaywallRepairReport => ({
  dryRun: !normalized.apply,
  applyRequested: normalized.apply,
  inspectedCount: 0,
  likelyFalsePositives: 0,
  confirmedBlockingPaywalls: 0,
  declaredMeteredCases: 0,
  unknownCases: 0,
  skippedCases: 0,
  detectorVersionMismatchCount: 0,
  truncatedSourceCount: 0,
  articlesFromTruncatedSources: 0,
  appliedCount: 0,
  concurrentChangeCount: 0,
  failedCount: 0,
  artifactCount: 0,
  bySource: {},
  samples: [],
  assessments: [],
});

type RepairMetadata = {
  repairDetectorVersion: string;
  previousDetectorVersion: string | null;
  selectedEvidenceDetectorVersion: string | null;
  selectedEvidenceClassification: ArticleAccessClassification | null;
  selectedEvidenceCodes: string[];
  selectedEvidenceContradictingEvidenceCodes: string[];
  articleSummaryDetectorVersion: string | null;
  selectedEvidenceSource: "article_outcome" | "artifact" | null;
  selectedEvidenceArtifactId: string | null;
  previousClassification: ArticleAccessClassification;
  finalClassification: "ACCESSIBLE";
  previousIsPaywall: boolean;
  finalIsPaywall: false;
  previousOutcomeKind: string | null;
  enrichmentStatusAtRepair: string;
  artifactWindowTruncated: boolean;
  optimisticArticleUpdatedAt: string;
  repairTimestamp: string;
  reason: string;
};

const buildRepairMetadata = (
  article: PaywallRepairArticle,
  assessment: PaywallRepairAssessment,
  repairTimestamp: string,
): RepairMetadata => {
  const articleSummaryAccess = readArticleAccess(article);
  const selectedAccess = assessment.currentAccess;
  return {
    repairDetectorVersion: ARTICLE_ACCESS_DETECTOR_VERSION,
    previousDetectorVersion: selectedAccess?.detectorVersion ?? null,
    selectedEvidenceDetectorVersion: selectedAccess?.detectorVersion ?? null,
    selectedEvidenceClassification: selectedAccess?.classification ?? null,
    selectedEvidenceCodes: boundedCodes(selectedAccess?.evidenceCodes ?? []),
    selectedEvidenceContradictingEvidenceCodes: boundedCodes(selectedAccess?.contradictingEvidenceCodes ?? []),
    articleSummaryDetectorVersion: articleSummaryAccess?.detectorVersion ?? null,
    selectedEvidenceSource: assessment.selectedEvidenceSource,
    selectedEvidenceArtifactId: sanitizeEnrichmentEvidenceText(assessment.selectedEvidenceArtifactId, 120),
    previousClassification: assessment.currentClassification,
    finalClassification: "ACCESSIBLE",
    previousIsPaywall: article.isPaywall,
    finalIsPaywall: false,
    previousOutcomeKind: assessment.previousOutcomeKind,
    enrichmentStatusAtRepair: article.enrichmentStatus,
    artifactWindowTruncated: assessment.artifactWindowTruncated,
    optimisticArticleUpdatedAt: article.updatedAt.toISOString(),
    repairTimestamp,
    reason: "high_confidence_accessible_body",
  };
};

const repairedOutcome = (
  article: PaywallRepairArticle,
  assessment: PaywallRepairAssessment,
  repairMetadata: RepairMetadata,
): PlainObject => {
  const outcome = readOutcomeRecord(article.enrichmentOutcome) ?? {};
  // The selected access snapshot is authoritative for the repaired decision.
  // The Article's prior summary is retained only as historical metadata.
  const previousAccess = assessment.currentAccess;
  if (!previousAccess) return {};

  // Patch an explicit bounded Article-summary whitelist. This is a
  // classification repair, not a synthetic enrichment attempt: preserve the
  // coherent outcome kind and diagnostics, but never spread arbitrary stored
  // JSON back into the Article row.
  const previousOutcomeKind = typeof outcome.kind === "string" ? outcome.kind : null;
  const accessSummary: ArticleAccessOutcomeSummary = {
    ...previousAccess,
    classification: "ACCESSIBLE",
    sourceStage: "agent3",
    confidence: "HIGH",
    detectorVersion: ARTICLE_ACCESS_DETECTOR_VERSION,
    evidenceCodes: assessment.evidenceCodes.slice(0, 12),
    contradictingEvidenceCodes: assessment.contradictingEvidenceCodes.slice(0, 12),
    usableBodyExtracted: true,
    articleScopedGateOrOverlayDetected: false,
    decisive: true,
    previousIsPaywall: article.isPaywall,
    finalIsPaywall: false,
    overrideReason: "Paywall repair: high-confidence ACCESSIBLE body with no article-scoped blocking evidence.",
  };
  const boundedOutcome: PlainObject = {
    schemaVersion: outcome.schemaVersion === 1 ? 1 : 1,
    ...(typeof outcome.extractorVersion === "string" && sanitizeEnrichmentEvidenceText(outcome.extractorVersion, 80)
      ? { extractorVersion: sanitizeEnrichmentEvidenceText(outcome.extractorVersion, 80) }
      : {}),
    kind: previousOutcomeKind,
    articleId: typeof outcome.articleId === "number" ? outcome.articleId : article.id,
    articleUrl: sanitizeEnrichmentEvidenceUrl(outcome.articleUrl),
    method: sanitizeEnrichmentEvidenceText(outcome.method, 40),
    confidence: typeof outcome.confidence === "number" && Number.isFinite(outcome.confidence)
      ? Math.min(1, Math.max(0, outcome.confidence))
      : 0,
    rejectionCode: sanitizeEnrichmentEvidenceText(outcome.rejectionCode, 80),
    rejectionHttpStatus: typeof outcome.rejectionHttpStatus === "number" ? outcome.rejectionHttpStatus : null,
    rejectionDetail: sanitizeEnrichmentEvidenceText(outcome.rejectionDetail, 240),
    retryAfterAt: sanitizeEnrichmentEvidenceText(outcome.retryAfterAt, 80),
    error: sanitizeEnrichmentEvidenceText(outcome.error, 240),
    rejectionDiagnostics: sanitizeBoundedDiagnostic(outcome.rejectionDiagnostics),
    retryDiagnostics: sanitizeBoundedDiagnostic(outcome.retryDiagnostics),
    browserFallback: isPlainObject(outcome.browserFallback)
      ? {
          attempted: outcome.browserFallback.attempted === true,
          succeeded: outcome.browserFallback.succeeded === true,
          runtimeUnavailable: outcome.browserFallback.runtimeUnavailable === true,
          rateLimited: outcome.browserFallback.rateLimited === true,
          statusCode: typeof outcome.browserFallback.statusCode === "number" ? outcome.browserFallback.statusCode : null,
          browserRejectedReason: sanitizeEnrichmentEvidenceText(outcome.browserFallback.browserRejectedReason, 120),
          browserFallbackSkippedReason: sanitizeEnrichmentEvidenceText(outcome.browserFallback.browserFallbackSkippedReason, 80),
        }
      : null,
    provenance: isPlainObject(outcome.provenance)
      ? {
          sourceId: sanitizeEnrichmentEvidenceText(outcome.provenance.sourceId, 120),
          categoryId: sanitizeEnrichmentEvidenceText(outcome.provenance.categoryId, 120),
          feedOrigin: sanitizeEnrichmentEvidenceText(outcome.provenance.feedOrigin, 40),
          feedUrl: sanitizeEnrichmentEvidenceUrl(outcome.provenance.feedUrl),
          ingestArtifactId: sanitizeEnrichmentEvidenceText(outcome.provenance.ingestArtifactId, 120),
          ingestPipelineRunId: sanitizeEnrichmentEvidenceText(outcome.provenance.ingestPipelineRunId, 120),
          earlyAccessEvidence: isPlainObject(outcome.provenance.earlyAccessEvidence)
            ? {
                classification: asClassification(outcome.provenance.earlyAccessEvidence.classification),
                sourceStage: sanitizeEnrichmentEvidenceText(outcome.provenance.earlyAccessEvidence.sourceStage, 20),
                evidenceCodes: sanitizeBoundedCodeArray(outcome.provenance.earlyAccessEvidence.evidenceCodes),
                contradictingEvidenceCodes: sanitizeBoundedCodeArray(outcome.provenance.earlyAccessEvidence.contradictingEvidenceCodes),
              }
            : null,
          earlyAccessRecovery: isPlainObject(outcome.provenance.earlyAccessRecovery)
            ? {
                status: sanitizeEnrichmentEvidenceText(outcome.provenance.earlyAccessRecovery.status, 30),
                artifactTypesQueried: Array.isArray(outcome.provenance.earlyAccessRecovery.artifactTypesQueried)
                  ? outcome.provenance.earlyAccessRecovery.artifactTypesQueried.slice(0, 2).map((entry) => sanitizeEnrichmentEvidenceText(entry, 50)).filter((entry): entry is string => Boolean(entry))
                  : [],
                artifactsScanned: typeof outcome.provenance.earlyAccessRecovery.artifactsScanned === "number" ? Math.min(200, Math.max(0, Math.floor(outcome.provenance.earlyAccessRecovery.artifactsScanned))) : 0,
                artifactWindowLimit: typeof outcome.provenance.earlyAccessRecovery.artifactWindowLimit === "number" ? Math.min(200, Math.max(1, Math.floor(outcome.provenance.earlyAccessRecovery.artifactWindowLimit))) : 200,
                candidateLimitPerArtifact: typeof outcome.provenance.earlyAccessRecovery.candidateLimitPerArtifact === "number" ? Math.min(100, Math.max(1, Math.floor(outcome.provenance.earlyAccessRecovery.candidateLimitPerArtifact))) : 100,
                matchingArtifactType: sanitizeEnrichmentEvidenceText(outcome.provenance.earlyAccessRecovery.matchingArtifactType, 60),
                matchingArtifactId: sanitizeEnrichmentEvidenceText(outcome.provenance.earlyAccessRecovery.matchingArtifactId, 120),
                candidateMatchType: sanitizeEnrichmentEvidenceText(outcome.provenance.earlyAccessRecovery.candidateMatchType, 30),
                windowTruncated: outcome.provenance.earlyAccessRecovery.windowTruncated === true,
              }
            : null,
          earlyAccessRecoveryWindowTruncated: outcome.provenance.earlyAccessRecoveryWindowTruncated === true,
        }
      : null,
    access: accessSummary,
    paywallRepair: repairMetadata,
  };
  return boundedOutcome;
};

const repairArtifactPayload = (assessment: PaywallRepairAssessment, repairMetadata: RepairMetadata) => ({
  schemaVersion: 1,
  articleId: assessment.article.id,
  sourceId: sanitizeEnrichmentEvidenceText(assessment.article.sourceId, 120),
  categoryId: sanitizeEnrichmentEvidenceText(assessment.article.categoryId, 120),
  articleUrl: assessment.sanitizedSample.canonicalUrl,
  artifactKind: "paywall_classification_repair",
  ...repairMetadata,
  evidenceCodes: assessment.evidenceCodes.slice(0, 12),
  contradictingEvidenceCodes: assessment.contradictingEvidenceCodes.slice(0, 12),
  reason: repairMetadata.reason,
});

export async function runPaywallRepair(
  options: PaywallRepairExecutionOptions = {},
  db: PaywallRepairDb = prisma as unknown as PaywallRepairDb,
): Promise<PaywallRepairReport> {
  const normalized = validatePaywallRepairExecution(options, options.environment ?? process.env);
  const report = buildReport(options, normalized);
  const articles = await db.article.findMany({
    where: {
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
      isPaywall: true,
      bodyText: { not: null },
      enrichmentStatus: { in: ["ENRICHED", "ENRICHMENT_FAILED"] },
    },
    select: {
      id: true,
      sourceId: true,
      categoryId: true,
      title: true,
      canonicalUrl: true,
      sourceUrl: true,
      bodyText: true,
      isPaywall: true,
      enrichmentStatus: true,
      enrichmentOutcome: true,
      updatedAt: true,
    },
    orderBy: [{ sourceId: "asc" }, { id: "asc" }],
    take: normalized.limit,
  });
  const sourceIds = [...new Set(articles.map((article) => article.sourceId))];
  const windows = await loadEvidenceWindows(db, sourceIds);
  const rawArticlesById = new Map(articles.map((article) => [article.id, article]));
  const truncatedSourceIds = new Set<string>();

  for (const article of articles) {
    const assessment = assessPaywallRepair(article, windows.get(article.sourceId) ?? {
      artifacts: [],
      truncated: false,
      queryFailed: true,
      appliedRepairArticleIds: new Set(),
      malformedEvidenceArticleIds: new Set(),
    });
    report.inspectedCount += 1;
    report.assessments.push(assessment);
    if (assessment.artifactWindowTruncated) {
      if (!truncatedSourceIds.has(article.sourceId)) {
        truncatedSourceIds.add(article.sourceId);
        report.truncatedSourceCount += 1;
      }
      report.articlesFromTruncatedSources += 1;
    }
    incrementReport(report, assessment);
  }

  if (!normalized.apply) return report;

  const run = await db.pipelineRun.create({
    data: {
      status: "PAYWALL_REPAIR_RUNNING",
      targetCount: report.likelyFalsePositives,
      summary: {
        artifactKind: "paywall_classification_repair_run",
        dryRun: false,
        detectorVersion: ARTICLE_ACCESS_DETECTOR_VERSION,
        limit: normalized.limit,
      },
    },
    select: { id: true },
  });

  for (const assessment of report.assessments.filter((entry) => entry.repairEligible)) {
    const rawArticle = rawArticlesById.get(assessment.article.id);
    if (!rawArticle || activeRepairArticleIds.has(rawArticle.id)) {
      report.concurrentChangeCount += 1;
      continue;
    }
    activeRepairArticleIds.add(rawArticle.id);
    try {
      const repairTimestamp = new Date().toISOString();
      const repairMetadata = buildRepairMetadata(rawArticle, assessment, repairTimestamp);
      const result = await db.$transaction(async (tx) => {
        const update = await tx.article.updateMany({
          where: {
            id: assessment.article.id,
            isPaywall: true,
            updatedAt: assessment.article.updatedAt,
          },
          data: {
            isPaywall: false,
            enrichmentOutcome: repairedOutcome(rawArticle, assessment, repairMetadata),
          },
        });
        if (update.count !== 1) return "CONCURRENTLY_CHANGED" as const;
        await tx.pipelineArtifact.create({
          data: {
            pipelineRunId: run.id,
            sourceId: assessment.article.sourceId,
            categoryId: assessment.article.categoryId,
            artifactType: PAYWALL_REPAIR_ARTIFACT_TYPE,
            status: "APPLIED",
            candidateCount: 1,
            payload: repairArtifactPayload(assessment, repairMetadata),
            errorLog: null,
          },
        });
        return "APPLIED" as const;
      });
      if (result === "APPLIED") {
        report.appliedCount += 1;
        report.artifactCount += 1;
      } else {
        report.concurrentChangeCount += 1;
      }
    } catch {
      report.failedCount += 1;
    } finally {
      activeRepairArticleIds.delete(rawArticle.id);
    }
  }

  if (db.pipelineRun.update) {
    await db.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: report.failedCount > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        finishedAt: new Date(),
        artifactCount: report.artifactCount,
        summary: {
          artifactKind: "paywall_classification_repair_run",
          detectorVersion: ARTICLE_ACCESS_DETECTOR_VERSION,
          inspectedCount: report.inspectedCount,
          appliedCount: report.appliedCount,
          concurrentChangeCount: report.concurrentChangeCount,
          failedCount: report.failedCount,
        },
      },
    });
  }

  return report;
}

export const formatPaywallRepairReport = (report: PaywallRepairReport): string => JSON.stringify({
  dryRun: report.dryRun,
  applyRequested: report.applyRequested,
  detectorVersion: ARTICLE_ACCESS_DETECTOR_VERSION,
  inspectedCount: report.inspectedCount,
  likelyFalsePositives: report.likelyFalsePositives,
  confirmedBlockingPaywalls: report.confirmedBlockingPaywalls,
  declaredMeteredCases: report.declaredMeteredCases,
  unknownCases: report.unknownCases,
  skippedCases: report.skippedCases,
  detectorVersionMismatchCount: report.detectorVersionMismatchCount,
  truncatedSourceCount: report.truncatedSourceCount,
  articlesFromTruncatedSources: report.articlesFromTruncatedSources,
  appliedCount: report.appliedCount,
  concurrentChangeCount: report.concurrentChangeCount,
  failedCount: report.failedCount,
  artifactCount: report.artifactCount,
  bySource: report.bySource,
  samples: report.samples,
}, null, 2);
