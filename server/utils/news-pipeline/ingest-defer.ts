import type { IngestDeferredReason, IngestResult } from "./types";

export const isIngestDeferredReason = (
  reason: IngestResult["deferredReason"],
): reason is IngestDeferredReason =>
  reason === "rate_limited" ||
  reason === "redirect_retry" ||
  reason === "governor_deferred";

export const isIngestResultDeferred = (
  result: Pick<IngestResult, "deferredReason">,
): boolean => isIngestDeferredReason(result.deferredReason);
