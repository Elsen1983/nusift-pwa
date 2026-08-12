import { describe, expect, it } from "vitest";
import { boundedPipelineItemError, isUnsafePipelineInvariantError } from "./item-failure";

describe("pipeline item failure policy", () => {
  it("keeps programming and invariant failures batch-fatal", () => {
    expect(isUnsafePipelineInvariantError(new TypeError("bad shape"))).toBe(true);
    expect(isUnsafePipelineInvariantError(Object.assign(new Error("broken"), { name: "InvariantError" }))).toBe(true);
    expect(isUnsafePipelineInvariantError(new Error("publisher unavailable"))).toBe(false);
  });

  it("bounds and redacts item diagnostics", () => {
    const diagnostic = boundedPipelineItemError(
      new Error("fetch https://example.com/a?token=secret&x=1 authorization=BearerSecret " + "x".repeat(500)),
    );
    expect(diagnostic.length).toBeLessThanOrEqual(300);
    expect(diagnostic).not.toContain("secret");
    expect(diagnostic).not.toContain("BearerSecret");
    expect(diagnostic).toContain("[redacted]");
  });
});
