import { describe, expect, it } from "vitest";
import { describeRedirectStatus } from "./redirect-status";

function renderRedirectStatusLine(status: string, nextRetryAt: string | null = null): string {
  const descriptor = describeRedirectStatus(status, nextRetryAt);
  if (descriptor.terminal) return `${descriptor.label} · no automatic retry`;
  if (descriptor.retryable && descriptor.nextRetryAt) return `${descriptor.label} · next eligible ${descriptor.nextRetryAt}`;
  if (descriptor.retryable) return `${descriptor.label} · next eligible soon`;
  return descriptor.label;
}

describe("redirect status admin rendering semantics", () => {
  it.each([
    ["RESOLVED", "resolved"],
    ["SECURITY_REJECTED", "terminal — security rejected · no automatic retry"],
    ["INVALID_REDIRECT", "terminal — invalid redirect · no automatic retry"],
    ["EXHAUSTED", "terminal — manual reprocess only · no automatic retry"],
  ])("renders %s without retry wording", (status, expected) => {
    const rendered = renderRedirectStatusLine(status, "2030-01-01T00:00:00.000Z");
    expect(rendered).toBe(expected);
    expect(rendered).not.toContain("next eligible");
  });

  it("renders retry eligibility only for RETRYABLE", () => {
    expect(renderRedirectStatusLine("RETRYABLE", "2030-01-01T00:00:00.000Z"))
      .toContain("next eligible 2030-01-01T00:00:00.000Z");
  });
});
