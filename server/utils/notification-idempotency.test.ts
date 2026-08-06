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

  it("recognizes only a Notification dedupe-key P2002", () => {
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: ["dedupeKey"] } })).toBe(true);
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: ["endpoint"] } })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: "Notification_dedupeKey_key" } })).toBe(true);
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: "dedupeKeyBackup" } })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: "otherDedupeKeyValue" } })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: "unrelated_notification_dedupekey_archive" } })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: ["userId"] } })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: ["dedupeKey"], driverAdapterError: { cause: { constraint: { fields: ["other"] } } } } })).toBe(true);
    expect(isUniqueConstraintConflict({ code: "P2003" })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2010", meta: { target: ["dedupeKey"] } })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2010", message: "duplicate key Notification_dedupeKey_key" })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2010", message: "foreign key violation" })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2010", message: "timeout while waiting for connection" })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2010", message: "serialization failure" })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2010", message: "malformed query" })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2010", message: "duplicate" })).toBe(false);
    expect(isUniqueConstraintConflict({ code: "P2002", meta: { target: ["dedupeKey"], driverAdapterError: { cause: { constraint: { fields: ["other"] } } }, huge: "x".repeat(100_000) } })).toBe(true);
    expect(isUniqueConstraintConflict(new Error("P2002"))).toBe(false);
  });
});
