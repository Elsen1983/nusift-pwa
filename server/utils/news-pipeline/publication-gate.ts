import { isBlockingInterstitialBody } from "./article-body-policy";

export type PipelineStageId = `agent${number}`;

const DEFAULT_TERMINAL_STAGE: PipelineStageId = "agent3";
const STAGE_PATTERN = /^agent[1-9]\d*$/;

/** Minimum durable body size required at the user-feed publication boundary. */
export const MIN_USABLE_AGENT3_BODY_TEXT_LENGTH = 500;

export function hasUsableAgent3BodyText(bodyText: string | null | undefined): boolean {
  return typeof bodyText === "string" &&
    bodyText.trim().length >= MIN_USABLE_AGENT3_BODY_TEXT_LENGTH &&
    !isBlockingInterstitialBody(bodyText);
}

/**
 * Runtime defense-in-depth for rows that passed the database publication
 * predicate but may have been malformed or modified outside the pipeline.
 */
export function isEffectivelyPublishableArticle(article: {
  title: string | null | undefined;
  canonicalUrl: string | null | undefined;
  bodyText: string | null | undefined;
}): boolean {
  return Boolean(
    article.title?.trim() &&
    article.canonicalUrl?.trim() &&
    hasUsableAgent3BodyText(article.bodyText),
  );
}

export function getTerminalPublicationStage(): PipelineStageId {
  const configured = process.env.NUXT_PIPELINE_TERMINAL_STAGE?.trim().toLowerCase();
  return configured && STAGE_PATTERN.test(configured)
    ? configured as PipelineStageId
    : DEFAULT_TERMINAL_STAGE;
}

/**
 * Database predicate for the user-facing feed. Admin/diagnostic queries should
 * not reuse this predicate because candidates and failures must remain visible
 * there.
 */
export function buildUserFeedPublicationWhere() {
  return {
    publicationStatus: "PUBLISHED" as const,
    publicationStage: getTerminalPublicationStage(),
    publicationReadyAt: { not: null },
    enrichmentStatus: "ENRICHED" as const,
    canonicalUrl: { not: null },
    title: { not: "" },
    bodyText: { not: null },
  };
}

export function buildPublicationGateUpdate(input: {
  stage: PipelineStageId;
  publishable: boolean;
  completedAt: Date;
  /** Status used when a previously visible row is no longer publishable. */
  nonPublishableStatus?: "PROCESSING" | "REJECTED";
}) {
  if (!input.publishable) {
    return {
      publicationStatus: input.nonPublishableStatus ?? "PROCESSING",
      publicationStage: input.stage,
      publicationReadyAt: null,
    } as const;
  }

  if (input.stage === getTerminalPublicationStage()) {
    return {
      publicationStatus: "PUBLISHED" as const,
      publicationStage: input.stage,
      publicationReadyAt: input.completedAt,
    };
  }

  return {
    publicationStatus: "PROCESSING" as const,
    publicationStage: input.stage,
    publicationReadyAt: null,
  };
}
