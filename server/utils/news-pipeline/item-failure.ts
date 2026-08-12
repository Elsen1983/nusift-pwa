import { sanitizeHostEvidenceUrl } from "./canonical-host-scope";

/** Programming failures are never downgraded to publisher/item failures. */
export function isUnsafePipelineInvariantError(error: unknown): boolean {
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError ||
    error instanceof EvalError ||
    error instanceof URIError
  ) return true;
  const name = error instanceof Error ? error.name : "";
  return name === "AssertionError" || name === "InvariantError";
}

/** Bounded diagnostic without query values, credentials, headers, or bodies. */
export function boundedPipelineItemError(error: unknown, maxLength = 300): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutUrls = raw.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeHostEvidenceUrl(url, 120));
  const redacted = withoutUrls
    .replace(/(authorization|cookie|password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return (redacted || "Unknown item failure").slice(0, Math.max(1, maxLength));
}
