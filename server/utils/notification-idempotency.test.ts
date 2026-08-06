import { describe, expect, it } from "vitest";
import { dailyDigestDedupeKey, isUniqueConstraintConflict } from "./notification-idempotency";

describe("notification idempotency", () => {
  it("uses a deterministic user and UTC calendar day key", () => {
    expect(dailyDigestDedupeKey("user-1", new Date(Date.UTC(2026, 7, 6)))).toBe("DAILY_DIGEST:user-1:2026-08-06");
    expect(dailyDigestDedupeKey("user-1", new Date(Date.UTC(2026, 7, 6)))).toBe(
      dailyDigestDedupeKey("user-1", new Date(Date.UTC(2026, 7, 6))),
    );
    expect(dailyDigestDedupeKey("user-1", new Date(Date.UTC(2026, 7, 7))).toString()).not.toBe(
      dailyDigestDedupeKey("user-1", new Date(Date.UTC(2026, 7, 6))),
    );
  });

  it("recognizes only Prisma unique conflicts", () => {
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: ["dedupeKey"] } })).toBe(true);
    expect(isUniqueConstraintConflict({ code: "P2003" })).toBe(false);
    expect(isUniqueConstraintConflict(new Error("P2002"))).toBe(false);
  });
});
