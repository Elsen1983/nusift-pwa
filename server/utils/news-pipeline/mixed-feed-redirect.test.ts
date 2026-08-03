import { describe, expect, it } from "vitest";
import { buildRedirectRetryKey } from "./redirect-retry-state";

describe("mixed-feed per-redirect cooldown semantics", () => {
  it("keys failed redirect entries independently from valid siblings", () => {
    const failed = buildRedirectRetryKey("https://aggregator.example/rd?id=failed");
    const sibling = buildRedirectRetryKey("https://aggregator.example/rd?id=sibling");
    expect(failed).not.toBeNull();
    expect(sibling).not.toBeNull();
    expect(failed?.urlHash).not.toBe(sibling?.urlHash);
    // The durable key is the entry URL, not the source/category target, so a
    // sibling article from the same feed cannot inherit the failed entry's cooldown.
  });
});
