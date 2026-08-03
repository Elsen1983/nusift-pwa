import { describe, expect, it } from "vitest";
import {
  classifyBrowserFailureOrigin,
  classifyStaticFailureOrigin,
  healthDescriptionForBrowserFailure,
  isGenuineHardSourceEvidence,
} from "./failure-origin";

describe("classifyBrowserFailureOrigin", () => {
  it("classifies BROWSER_RUNTIME_UNAVAILABLE as platform runtime failure", () => {
    expect(classifyBrowserFailureOrigin("BROWSER_RUNTIME_UNAVAILABLE")).toBe("platform_runtime_failure");
  });

  it("classifies BROWSER_FALLBACK_DISABLED as configuration failure", () => {
    expect(classifyBrowserFailureOrigin("BROWSER_FALLBACK_DISABLED")).toBe("configuration_failure");
  });

  it("classifies BROWSER_NO_CANDIDATES as publisher content failure", () => {
    expect(classifyBrowserFailureOrigin("BROWSER_NO_CANDIDATES")).toBe("publisher_content_failure");
  });

  it("returns null for missing status", () => {
    expect(classifyBrowserFailureOrigin(null)).toBeNull();
    expect(classifyBrowserFailureOrigin(undefined)).toBeNull();
  });
});

describe("classifyStaticFailureOrigin", () => {
  it("treats failed/weak as publisher content evidence", () => {
    expect(classifyStaticFailureOrigin("failed")).toBe("publisher_content_failure");
    expect(classifyStaticFailureOrigin("weak")).toBe("publisher_content_failure");
  });

  it("treats blocked as genuine publisher evidence (publisher-side blocking)", () => {
    expect(classifyStaticFailureOrigin("blocked")).toBe("publisher_content_failure");
  });

  it("returns null for productive or missing", () => {
    expect(classifyStaticFailureOrigin("productive")).toBeNull();
    expect(classifyStaticFailureOrigin(null)).toBeNull();
  });
});

describe("isGenuineHardSourceEvidence", () => {
  it("static failure + runtime-unavailable browser does NOT create a hard-source profile", () => {
    expect(isGenuineHardSourceEvidence({
      staticQuality: "failed",
      browserStatus: "BROWSER_RUNTIME_UNAVAILABLE",
    })).toBe(false);
  });

  it("static failure + fallback-disabled browser does NOT create a profile", () => {
    expect(isGenuineHardSourceEvidence({
      staticQuality: "blocked",
      browserStatus: "BROWSER_FALLBACK_DISABLED",
    })).toBe(false);
  });

  it("static failure + genuine browser no-candidates CAN create one", () => {
    expect(isGenuineHardSourceEvidence({
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
    })).toBe(true);
  });

  it("static publisher block + genuine browser no-candidates CAN create one", () => {
    expect(isGenuineHardSourceEvidence({
      staticQuality: "blocked",
      browserStatus: "BROWSER_NO_CANDIDATES",
    })).toBe(true);
  });
});

describe("healthDescriptionForBrowserFailure", () => {
  it("describes runtime unavailability without blaming the publisher", () => {
    expect(healthDescriptionForBrowserFailure("BROWSER_RUNTIME_UNAVAILABLE"))
      .toContain("browser runtime unavailable");
    expect(healthDescriptionForBrowserFailure("BROWSER_RUNTIME_UNAVAILABLE"))
      .not.toContain("blocked");
  });

  it("describes configuration failures distinctly", () => {
    expect(healthDescriptionForBrowserFailure("BROWSER_FALLBACK_DISABLED"))
      .toContain("browser runtime configuration invalid");
  });

  it("returns null for publisher-content statuses", () => {
    expect(healthDescriptionForBrowserFailure("BROWSER_NO_CANDIDATES")).toBeNull();
    expect(healthDescriptionForBrowserFailure(null)).toBeNull();
  });
});
