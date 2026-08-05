export type RedirectArtifactStatus =
  | "RETRYABLE"
  | "RESOLVED"
  | "SECURITY_REJECTED"
  | "INVALID_REDIRECT"
  | "EXHAUSTED";

export type RedirectStatusDescriptor = {
  status: RedirectArtifactStatus;
  label: string;
  terminal: boolean;
  retryable: boolean;
  resolved: boolean;
  nextRetryAt: string | null;
};

/**
 * The single redirect-status vocabulary shared by diagnostics and the admin UI.
 * Non-retryable statuses always clear nextRetryAt so callers cannot render
 * retry eligibility for resolved or terminal states.
 */
export function describeRedirectStatus(
  status: string,
  nextRetryAt: string | null = null,
): RedirectStatusDescriptor {
  switch (status) {
    case "RESOLVED":
      return {
        status: "RESOLVED",
        label: "resolved",
        terminal: false,
        retryable: false,
        resolved: true,
        nextRetryAt: null,
      };
    case "SECURITY_REJECTED":
      return {
        status: "SECURITY_REJECTED",
        label: "terminal — security rejected",
        terminal: true,
        retryable: false,
        resolved: false,
        nextRetryAt: null,
      };
    case "INVALID_REDIRECT":
      return {
        status: "INVALID_REDIRECT",
        label: "terminal — invalid redirect",
        terminal: true,
        retryable: false,
        resolved: false,
        nextRetryAt: null,
      };
    case "EXHAUSTED":
      return {
        status: "EXHAUSTED",
        label: "terminal — manual reprocess only",
        terminal: true,
        retryable: false,
        resolved: false,
        nextRetryAt: null,
      };
    case "RETRYABLE":
    default:
      return {
        status: "RETRYABLE",
        label: "retryable",
        terminal: false,
        retryable: true,
        resolved: false,
        nextRetryAt,
      };
  }
}
