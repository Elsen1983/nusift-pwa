import { describe, expect, it } from "vitest";
import { normalizeNotificationTelemetry } from "./notification-telemetry";

describe("notification telemetry normalization", () => {
  it("reads explicit counters without inferring unrelated outcomes", () => {
    expect(normalizeNotificationTelemetry({
      telemetryVersion: 2,
      usersMatchedSchedule: 1,
      inboxNotificationsCreated: 1,
      pushesDelivered: 0,
    })).toMatchObject({
      telemetryVersion: 2,
      usersMatchedSchedule: 1,
      inboxNotificationsCreated: 1,
      pushesDelivered: 0,
      usersWithActivePushSubscriptions: null,
      pushesFailed: null,
    });
  });

  it("keeps missing legacy details unavailable instead of displaying zero", () => {
    expect(normalizeNotificationTelemetry({ usersProcessed: 4, pushesSent: 2, skippedEmpty: 1 })).toMatchObject({
      usersProcessed: 4,
      pushesSent: 2,
      skippedEmpty: 1,
      usersMatchedSchedule: null,
      inboxNotificationsCreated: null,
      pushesDelivered: null,
    });
  });

  it("bounds diagnostic errors and counts", () => {
    const normalized = normalizeNotificationTelemetry({
      usersMatchedSchedule: -5,
      pushesFailed: 9_999_999,
      lastError: "x".repeat(1000),
    });
    expect(normalized.usersMatchedSchedule).toBe(0);
    expect(normalized.pushesFailed).toBe(1_000_000);
    expect(normalized.lastError).toHaveLength(300);
  });
});
