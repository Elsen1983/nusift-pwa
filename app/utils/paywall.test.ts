import { describe, expect, it } from "vitest";
import { isConfirmedBlockingPaywall, toPublicAccessClassification } from "./paywall";

describe("public paywall semantics", () => {
  it.each([
    "ACCESSIBLE",
    "METERED_OR_DECLARED",
    "UNKNOWN",
    "INTERSTITIAL_OR_CHALLENGE",
    "HTTP_ACCESS_BLOCKED",
    null,
    undefined,
    "invalid",
  ])("does not block readable or non-confirmed classification: %s", (classification) => {
    expect(isConfirmedBlockingPaywall({ accessClassification: classification })).toBe(false);
  });

  it("requires explicit structured PAYWALL_BLOCKED semantics", () => {
    expect(isConfirmedBlockingPaywall({ isPaywall: true, accessClassification: "PAYWALL_BLOCKED" })).toBe(true);
    expect(isConfirmedBlockingPaywall({ isPaywall: true })).toBe(false);
    expect(isConfirmedBlockingPaywall({ isPaywall: false, accessClassification: "PAYWALL_BLOCKED" })).toBe(true);
  });

  it("returns only the validated public classification union", () => {
    expect(toPublicAccessClassification("ACCESSIBLE")).toBe("ACCESSIBLE");
    expect(toPublicAccessClassification("raw evidence")).toBeNull();
    expect(toPublicAccessClassification({ classification: "PAYWALL_BLOCKED" })).toBeNull();
  });
});
