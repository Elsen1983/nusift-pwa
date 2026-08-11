import { describe, expect, it } from "vitest";
import { secretsMatch } from "./secure-secret";

describe("secretsMatch", () => {
  it("accepts identical secrets", () => {
    expect(secretsMatch("cron-secret-123", "cron-secret-123")).toBe(true);
  });

  it("rejects different and different-length secrets", () => {
    expect(secretsMatch("cron-secret-124", "cron-secret-123")).toBe(false);
    expect(secretsMatch("short", "longer-secret")).toBe(false);
  });

  it("rejects missing secrets", () => {
    expect(secretsMatch(undefined, "configured")).toBe(false);
    expect(secretsMatch("provided", undefined)).toBe(false);
  });
});
