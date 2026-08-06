import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userFindManyMock = vi.hoisted(() => vi.fn());
const notificationFindFirstMock = vi.hoisted(() => vi.fn());
const notificationCreateMock = vi.hoisted(() => vi.fn());
const articleFindManyMock = vi.hoisted(() => vi.fn());
const pushSubscriptionUpdateMock = vi.hoisted(() => vi.fn());
const sendPushNotificationMock = vi.hoisted(() => vi.fn());
const notificationUpdateMock = vi.hoisted(() => vi.fn());

vi.mock("./prisma", () => ({
  prisma: {
    user: { findMany: userFindManyMock },
    notification: {
      findFirst: notificationFindFirstMock,
      create: notificationCreateMock,
      update: notificationUpdateMock,
    },
    article: { findMany: articleFindManyMock },
    pushSubscription: { update: pushSubscriptionUpdateMock },
  },
}));

vi.mock("./push", () => ({
  getNotificationPayload: (title: string, body: string, url: string, type: string, data: unknown) => ({
    title,
    body,
    url,
    type,
    data,
  }),
  sendPushNotification: sendPushNotificationMock,
}));

describe("sendDueDailyNotifications", () => {
  beforeEach(() => {
    delete process.env.NUXT_PIPELINE_TERMINAL_STAGE;
    vi.clearAllMocks();
    notificationFindFirstMock.mockResolvedValue(null);
    notificationCreateMock.mockResolvedValue({ id: "notification-1" });
    sendPushNotificationMock.mockResolvedValue(undefined);
    pushSubscriptionUpdateMock.mockResolvedValue({});
    notificationUpdateMock.mockResolvedValue({});
  });

  it("can deliver one workflow-selected slot after the terminal pipeline stage", async () => {
    userFindManyMock.mockResolvedValue([
      {
        id: "morning-user",
        email: "morning@example.com",
        notificationScheduleSlot: "MORNING",
        allowBreakingNotifications: true,
        pushSubscriptions: [],
        sourceSubscriptions: [],
        categorySubscriptions: [],
      },
      {
        id: "evening-user",
        email: "evening@example.com",
        notificationScheduleSlot: "EVENING",
        allowBreakingNotifications: true,
        pushSubscriptions: [],
        sourceSubscriptions: [],
        categorySubscriptions: [],
      },
    ]);

    const { sendDueDailyNotifications } = await import("./notification-sender");
    const result = await sendDueDailyNotifications(
      new Date("2026-08-01T03:00:00.000Z"),
      ["MORNING"],
    );

    expect(result).toEqual([]);
    expect(notificationCreateMock).not.toHaveBeenCalled();
    expect(userFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { notificationScheduleSlot: { in: ["MORNING"] } },
    }));
  });

  it("counts articles from each user's active source and category subscriptions", async () => {
    userFindManyMock.mockResolvedValue([
      {
        id: "user-1",
        email: "one@example.com",
        notificationScheduleSlot: "MORNING",
        allowBreakingNotifications: true,
        pushSubscriptions: [],
        sourceSubscriptions: [{ sourceId: "source-1" }],
        categorySubscriptions: [{
          categoryId: "category-1",
          category: { pathUrl: "https://example.com/section" },
        }],
      },
      {
        id: "user-2",
        email: "two@example.com",
        notificationScheduleSlot: "MORNING",
        allowBreakingNotifications: true,
        pushSubscriptions: [],
        sourceSubscriptions: [{ sourceId: "source-2" }],
        categorySubscriptions: [],
      },
    ]);
    articleFindManyMock
      .mockResolvedValueOnce([      { id: 1, title: "A", canonicalUrl: "https://example.com/1", bodyText: "A".repeat(500) }])
      .mockResolvedValueOnce([
        { id: 2, title: "B", canonicalUrl: "https://example.com/2", bodyText: "B".repeat(500) },
        { id: 3, title: "C", canonicalUrl: "https://example.com/3", bodyText: "C".repeat(500) },
      ]);

    const { sendDueDailyNotifications } = await import("./notification-sender");
    await sendDueDailyNotifications(new Date("2026-07-31T08:00:00.000Z"));

    expect(userFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        sourceSubscriptions: { where: { isActive: true }, select: { sourceId: true } },
        categorySubscriptions: {
          where: { isActive: true },
          select: {
            categoryId: true,
            category: { select: { pathUrl: true } },
          },
        },
      }),
    }));
    expect(articleFindManyMock).toHaveBeenNthCalledWith(1, {
      where: {
        publicationStatus: "PUBLISHED",
        publicationStage: "agent3",
        publicationReadyAt: { gte: new Date("2026-07-30T08:00:00.000Z") },
        enrichmentStatus: "ENRICHED",
        canonicalUrl: { not: null },
        title: { not: "" },
        bodyText: { not: null },
        OR: [
          { sourceId: { in: ["source-1"] } },
          { categoryId: { in: ["category-1"] } },
          { category: { pathUrl: { in: ["https://example.com/section"] } } },
        ],
      },
      select: { id: true, title: true, canonicalUrl: true, bodyText: true },
      orderBy: { id: "asc" },
      take: 500,
    });
    expect(articleFindManyMock).toHaveBeenNthCalledWith(2, {
      where: {
        publicationStatus: "PUBLISHED",
        publicationStage: "agent3",
        publicationReadyAt: { gte: new Date("2026-07-30T08:00:00.000Z") },
        enrichmentStatus: "ENRICHED",
        canonicalUrl: { not: null },
        title: { not: "" },
        bodyText: { not: null },
        OR: [{ sourceId: { in: ["source-2"] } }],
      },
      select: { id: true, title: true, canonicalUrl: true, bodyText: true },
      orderBy: { id: "asc" },
      take: 500,
    });
    expect(notificationCreateMock.mock.calls[0]![0].data.body).toContain("1 new articles");
    expect(notificationCreateMock.mock.calls[1]![0].data.body).toContain("2 new articles");
  });

  it("treats a concurrent unique-key conflict as already notified without push", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "concurrent-user",
      email: "concurrent@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [{ endpoint: "https://push.example/concurrent", p256dh: "p", auth: "a", expirationTime: null }],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);
    notificationCreateMock
      .mockResolvedValueOnce({ id: "winner" })
      .mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002", meta: { target: ["dedupeKey"] } }));

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    const [first, second] = await Promise.all([
      sendDueDailyNotificationsInternal(new Date("2026-08-02T08:00:00.000Z"), ["MORNING"]),
      sendDueDailyNotificationsInternal(new Date("2026-08-02T08:00:00.000Z"), ["MORNING"]),
    ]);

    expect(notificationCreateMock).toHaveBeenCalledTimes(2);
    expect(sendPushNotificationMock).toHaveBeenCalledTimes(1);
    expect([first.stats.usersAlreadyNotified, second.stats.usersAlreadyNotified].sort()).toEqual([0, 1]);
    expect(first.stats.inboxNotificationFailures + second.stats.inboxNotificationFailures).toBe(0);
  });

  it("different intended UTC days may each claim a digest", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "different-day",
      email: "day@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);
    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    await sendDueDailyNotificationsInternal(new Date(Date.UTC(2026, 7, 2, 8)), ["MORNING"]);
    await sendDueDailyNotificationsInternal(new Date(Date.UTC(2026, 7, 3, 8)), ["MORNING"]);
    expect(notificationCreateMock).toHaveBeenCalledTimes(2);
    expect(notificationCreateMock.mock.calls[0]![0].data.dedupeKey).not.toBe(notificationCreateMock.mock.calls[1]![0].data.dedupeKey);
  });

  it("different users may each claim their own daily digest key", async () => {
    userFindManyMock.mockResolvedValue([
      {
        id: "user-a", email: "a@example.com", notificationScheduleSlot: "MORNING", allowBreakingNotifications: true,
        pushSubscriptions: [], sourceSubscriptions: [{ sourceId: "source-1" }], categorySubscriptions: [],
      },
      {
        id: "user-b", email: "b@example.com", notificationScheduleSlot: "MORNING", allowBreakingNotifications: true,
        pushSubscriptions: [], sourceSubscriptions: [{ sourceId: "source-1" }], categorySubscriptions: [],
      },
    ]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    await sendDueDailyNotificationsInternal(new Date("2026-08-02T08:00:00.000Z"), ["MORNING"]);

    expect(notificationCreateMock).toHaveBeenCalledTimes(2);
    expect(notificationCreateMock.mock.calls[0]![0].data.dedupeKey).not.toBe(notificationCreateMock.mock.calls[1]![0].data.dedupeKey);
  });

  it("duplicate workflow executions do not duplicate a per-user/day digest", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "user-dedup",
      email: "dedup@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{
      id: 1,
      title: "A",
      canonicalUrl: "https://example.com/a",
      bodyText: "A".repeat(500),
    }]);
    // First execution: no DAILY_DIGEST yet. Replay: already sent today.
    notificationFindFirstMock.mockResolvedValueOnce(null);
    notificationFindFirstMock.mockResolvedValueOnce({ id: "digest-1" });

    const { sendDueDailyNotifications } = await import("./notification-sender");
    const first = await sendDueDailyNotifications(
      new Date("2026-08-02T08:00:00.000Z"),
      ["MORNING"],
    );
    const replay = await sendDueDailyNotifications(
      new Date("2026-08-02T09:00:00.000Z"),
      ["MORNING"],
    );

    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(0);
    expect(notificationCreateMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry push after a previously persisted digest is found", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "dedup-push-user",
      email: "dedup-push@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [{ endpoint: "https://push.example/current", p256dh: "p", auth: "a", expirationTime: null }],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    notificationFindFirstMock.mockResolvedValue({ id: "already-persisted" });

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    const result = await sendDueDailyNotificationsInternal(new Date("2026-07-31T08:00:00.000Z"), ["MORNING"]);

    expect(result.stats.usersAlreadyNotified).toBe(1);
    expect(notificationCreateMock).not.toHaveBeenCalled();
    expect(sendPushNotificationMock).not.toHaveBeenCalled();
  });

  it("uses the configured terminal stage in the centralized count predicate", async () => {
    process.env.NUXT_PIPELINE_TERMINAL_STAGE = "agent4";
    userFindManyMock.mockResolvedValue([{
      id: "user-1",
      email: "one@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);

    const { sendDueDailyNotifications } = await import("./notification-sender");
    await sendDueDailyNotifications(new Date("2026-07-31T08:00:00.000Z"));

    expect(articleFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        publicationStatus: "PUBLISHED",
        publicationStage: "agent4",
        enrichmentStatus: "ENRICHED",
        canonicalUrl: { not: null },
        title: { not: "" },
        bodyText: { not: null },
        publicationReadyAt: { gte: new Date("2026-07-30T08:00:00.000Z") },
      }),
      select: { id: true, title: true, canonicalUrl: true, bodyText: true },
      orderBy: { id: "asc" },
      take: 500,
    }));
  });

  afterEach(() => {
    delete process.env.NUXT_PIPELINE_TERMINAL_STAGE;
  });

  it("excludes rows that the feed runtime guard excludes", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "user-1",
      email: "one@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([
      { title: "Valid", canonicalUrl: "https://example.com/valid", bodyText: "A".repeat(500) },
      { title: "   \t\n", canonicalUrl: "https://example.com/blank-title", bodyText: "A".repeat(500) },
      { title: "Valid", canonicalUrl: " \n\t", bodyText: "A".repeat(500) },
      { title: "Valid", canonicalUrl: "https://example.com/short", bodyText: "A".repeat(499) },
      { title: "Valid", canonicalUrl: "https://example.com/null", bodyText: null },
    ]);

    const { sendDueDailyNotifications } = await import("./notification-sender");
    await sendDueDailyNotifications(new Date("2026-07-31T08:00:00.000Z"));

    expect(notificationCreateMock.mock.calls[0]![0].data.body).toContain("1 new articles");
  });

  it("does not send an empty digest to a user without active subscriptions", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "user-1",
      email: "one@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [],
      sourceSubscriptions: [],
      categorySubscriptions: [],
    }]);

    const { sendDueDailyNotifications } = await import("./notification-sender");
    await sendDueDailyNotifications(new Date("2026-07-31T08:00:00.000Z"));

    expect(articleFindManyMock).not.toHaveBeenCalled();
    expect(notificationCreateMock).not.toHaveBeenCalled();
  });

  it("counts a category-path match when the subscribed category id has drifted", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "user-1",
      email: "one@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [],
      sourceSubscriptions: [],
      categorySubscriptions: [{
        categoryId: "legacy-category-id",
        category: { pathUrl: "https://example.com/section" },
      }],
    }]);
    articleFindManyMock.mockResolvedValue([{
      id: 42,
      title: "Path matched article",
      canonicalUrl: "https://example.com/article-42",
      bodyText: "A".repeat(500),
    }]);

    const { sendDueDailyNotifications } = await import("./notification-sender");
    await sendDueDailyNotifications(new Date("2026-07-31T08:00:00.000Z"));

    expect(articleFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { categoryId: { in: ["legacy-category-id"] } },
          { category: { pathUrl: { in: ["https://example.com/section"] } } },
        ],
      }),
    }));
    expect(notificationCreateMock.mock.calls[0]![0].data.body).toContain("1 new articles");
  });

  it("persists inbox delivery even when browser push is unavailable", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "inbox-only",
      email: "inbox-only@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    const result = await sendDueDailyNotificationsInternal(new Date("2026-07-31T08:00:00.000Z"), ["MORNING"]);
    const created = notificationCreateMock.mock.calls[0]![0].data;

    expect(created.status).toBe("SENT");
    expect(created.sentAt).toBeInstanceOf(Date);
    expect(result.stats).toMatchObject({
      telemetryVersion: 2,
      usersMatchedSchedule: 1,
      inboxNotificationsCreated: 1,
      usersWithActivePushSubscriptions: 0,
      pushSubscriptionsAttempted: 0,
      pushesDelivered: 0,
      pushesFailed: 0,
    });
  });

  it("creates the inbox row before attempting any browser push", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "ordered-user",
      email: "ordered@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [{ endpoint: "https://push.example/one", p256dh: "p", auth: "a", expirationTime: null }],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);
    const events: string[] = [];
    notificationCreateMock.mockImplementation(async () => { events.push("inbox"); return { id: "ordered-notification" }; });
    sendPushNotificationMock.mockImplementation(async () => { events.push("push"); });

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    await sendDueDailyNotificationsInternal(new Date("2026-07-31T08:00:00.000Z"), ["MORNING"]);

    expect(events).toEqual(["inbox", "push"]);
  });

  it("does not attempt push when inbox persistence fails", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "blocked-push",
      email: "blocked@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [{ endpoint: "https://push.example/one", p256dh: "p", auth: "a", expirationTime: null }],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);
    notificationCreateMock.mockRejectedValue(new Error("db unavailable"));

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    const result = await sendDueDailyNotificationsInternal(new Date("2026-07-31T08:00:00.000Z"), ["MORNING"]);

    expect(sendPushNotificationMock).not.toHaveBeenCalled();
    expect(result.stats.inboxNotificationFailures).toBe(1);
  });

  it("keeps the inbox valid after a transient push failure", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "transient-push",
      email: "transient@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [{ endpoint: "https://push.example/one", p256dh: "p", auth: "a", expirationTime: null }],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);
    sendPushNotificationMock.mockRejectedValue(Object.assign(new Error("temporary"), { statusCode: 503 }));

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    const result = await sendDueDailyNotificationsInternal(new Date("2026-07-31T08:00:00.000Z"), ["MORNING"]);

    expect(notificationCreateMock.mock.calls[0]![0].data.status).toBe("SENT");
    expect(result.stats.pushesFailed).toBe(1);
    expect(result.stats.inboxNotificationsCreated).toBe(1);
  });

  it("preserves both permanent failure diagnostics when deactivation persistence fails", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "diagnostic-user",
      email: "diagnostic@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [{ endpoint: "https://push.example/gone", p256dh: "p", auth: "a", expirationTime: null }],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);
    sendPushNotificationMock.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    pushSubscriptionUpdateMock.mockRejectedValue(new Error("deactivation db failure"));

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    const result = await sendDueDailyNotificationsInternal(new Date("2026-07-31T08:00:00.000Z"), ["MORNING"]);

    expect(result.stats.pushesFailed).toBe(1);
    expect(result.stats.stalePushSubscriptionsDeactivated).toBe(0);
    expect(result.stats.lastError).toContain("provider status 410");
    expect(result.stats.lastError).toContain("deactivation persistence failed");
    expect(notificationUpdateMock.mock.calls[0]![0].data.errorLog).toContain("provider status 410");
    expect(notificationUpdateMock.mock.calls[0]![0].data.errorLog).toContain("deactivation persistence failed");
    expect(notificationCreateMock.mock.calls[0]![0].data.status).toBe("SENT");
  });

  it("counts multiple endpoints and only deactivates proven permanent failures", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "multi-device",
      email: "multi@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [
        { endpoint: "https://push.example/one", p256dh: "p1", auth: "a1", expirationTime: null },
        { endpoint: "https://push.example/two", p256dh: "p2", auth: "a2", expirationTime: null },
        { endpoint: "https://push.example/three", p256dh: "p3", auth: "a3", expirationTime: null },
      ],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);
    sendPushNotificationMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { statusCode: 503 }));

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    const result = await sendDueDailyNotificationsInternal(new Date("2026-07-31T08:00:00.000Z"), ["MORNING"]);

    expect(result.stats).toMatchObject({
      usersWithActivePushSubscriptions: 1,
      pushSubscriptionsAttempted: 3,
      pushesDelivered: 1,
      pushesFailed: 2,
      stalePushSubscriptionsDeactivated: 1,
    });
    expect(pushSubscriptionUpdateMock).toHaveBeenCalledTimes(1);
    expect(pushSubscriptionUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { endpoint: "https://push.example/two" },
      data: { isActive: false, lastSeenAt: expect.any(Date) },
    }));
    expect(notificationCreateMock.mock.calls[0]![0].data.status).toBe("SENT");
  });

  it("counts a failed inbox persistence separately from push delivery", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "persistence-failure",
      email: "failure@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    articleFindManyMock.mockResolvedValue([{ id: 1, title: "A", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) }]);
    notificationCreateMock.mockRejectedValue(new Error("db unavailable"));

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    const result = await sendDueDailyNotificationsInternal(new Date("2026-07-31T08:00:00.000Z"), ["MORNING"]);

    expect(result.results).toEqual([]);
    expect(result.stats.inboxNotificationFailures).toBe(1);
    expect(result.stats.pushesFailed).toBe(0);
  });

  it("distinguishes already-notified and no-active-scope recipients", async () => {
    userFindManyMock.mockResolvedValue([
      { id: "already", email: "already@example.com", notificationScheduleSlot: "MORNING", allowBreakingNotifications: true, pushSubscriptions: [], sourceSubscriptions: [{ sourceId: "source-1" }], categorySubscriptions: [] },
      { id: "no-scope", email: "scope@example.com", notificationScheduleSlot: "MORNING", allowBreakingNotifications: true, pushSubscriptions: [], sourceSubscriptions: [], categorySubscriptions: [] },
    ]);
    notificationFindFirstMock.mockResolvedValueOnce({ id: "existing" }).mockResolvedValueOnce(null);

    const { sendDueDailyNotificationsInternal } = await import("./notification-sender");
    const result = await sendDueDailyNotificationsInternal(new Date("2026-07-31T08:00:00.000Z"), ["MORNING"]);

    expect(result.stats).toMatchObject({ usersMatchedSchedule: 2, usersAlreadyNotified: 1, usersWithoutActiveScope: 1 });
    expect(articleFindManyMock).not.toHaveBeenCalled();
  });

  it("keeps breaking inbox SENT and does not deactivate on transient push failure", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "breaking-transient",
      pushSubscriptions: [{ endpoint: "https://push.example/transient", p256dh: "p", auth: "a", expirationTime: null }],
    }]);
    sendPushNotificationMock.mockRejectedValue(Object.assign(new Error("temporary body"), { statusCode: 503, response: "secret body" }));

    const { sendBreakingNotification } = await import("./notification-sender");
    await sendBreakingNotification({ title: "Breaking", body: "Payload secret" , userId: "breaking-transient" });

    expect(notificationCreateMock.mock.calls[0]![0].data.status).toBe("SENT");
    expect(pushSubscriptionUpdateMock).not.toHaveBeenCalled();
    expect(notificationUpdateMock.mock.calls[0]![0].data.errorLog).toContain("provider status 503");
    expect(notificationUpdateMock.mock.calls[0]![0].data.errorLog).not.toContain("temporary body");
    expect(notificationUpdateMock.mock.calls[0]![0].data.errorLog).not.toContain("secret");
  });

  it("deactivates a breaking subscription only after a proven permanent 410", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "breaking-deactivate",
      pushSubscriptions: [{ endpoint: "https://push.example/gone", p256dh: "p", auth: "a", expirationTime: null }],
    }]);
    sendPushNotificationMock.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));

    const { sendBreakingNotification } = await import("./notification-sender");
    await sendBreakingNotification({ title: "Breaking", body: "News", userId: "breaking-deactivate" });

    expect(pushSubscriptionUpdateMock).toHaveBeenCalledTimes(1);
    expect(pushSubscriptionUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { endpoint: "https://push.example/gone" },
      data: { isActive: false, lastSeenAt: expect.any(Date) },
    }));
    expect(notificationCreateMock.mock.calls[0]![0].data.status).toBe("SENT");
  });

  it("retains breaking deactivation failure diagnostics and inbox validity", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "breaking-gone",
      pushSubscriptions: [{ endpoint: "https://push.example/gone", p256dh: "private-key", auth: "auth-key", expirationTime: null }],
    }]);
    sendPushNotificationMock.mockRejectedValue(Object.assign(new Error("provider response body"), { statusCode: 410 }));
    pushSubscriptionUpdateMock.mockRejectedValue(new Error("db failure"));

    const { sendBreakingNotification } = await import("./notification-sender");
    await sendBreakingNotification({ title: "Breaking", body: "payload-body", userId: "breaking-gone" });

    expect(notificationCreateMock.mock.calls[0]![0].data.status).toBe("SENT");
    const evidence = notificationUpdateMock.mock.calls[0]![0].data;
    expect(evidence.errorLog).toContain("provider status 410");
    expect(evidence.errorLog).toContain("deactivation persistence failed");
    expect(evidence.errorLog).not.toContain("push.example");
    expect(evidence.errorLog).not.toContain("private-key");
    expect(evidence.errorLog).not.toContain("auth-key");
    expect(evidence.errorLog).not.toContain("provider response body");
  });

  it("bounds breaking diagnostics and preserves a late permanent/deactivation failure", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "breaking-many",
      pushSubscriptions: Array.from({ length: 25 }, (_, index) => ({
        endpoint: `https://push.example/${index}`,
        p256dh: `key-${index}`,
        auth: `auth-${index}`,
        expirationTime: null,
      })),
    }]);
    sendPushNotificationMock.mockImplementation(async (_subscription: unknown, _payload: unknown) => {
      const call = sendPushNotificationMock.mock.calls.length;
      if (call === 25) throw Object.assign(new Error("provider response body"), { statusCode: 410 });
      throw Object.assign(new Error("transient response body"), { statusCode: 503 });
    });
    pushSubscriptionUpdateMock.mockRejectedValue(new Error("deactivation database failure"));

    const { sendBreakingNotification } = await import("./notification-sender");
    const result = await sendBreakingNotification({ title: "Breaking", body: "payload body", userId: "breaking-many" });

    expect(result.diagnostics).toBeTruthy();
    expect(result.diagnostics!.length).toBeLessThanOrEqual(300);
    expect(result.diagnostics).toContain("provider status 410");
    expect(result.diagnostics).toContain("deactivation persistence failed");
    expect(result.diagnostics).not.toContain("push.example");
    expect(result.diagnostics).not.toContain("key-24");
    expect(result.diagnostics).not.toContain("auth-24");
    expect(result.diagnostics).not.toContain("provider response body");
    expect(notificationCreateMock.mock.calls[0]![0].data.status).toBe("SENT");
  });

  it("keeps breaking inbox valid when final evidence persistence fails", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "breaking-evidence-failure",
      pushSubscriptions: [{ endpoint: "https://push.example/evidence", p256dh: "p", auth: "a", expirationTime: null }],
    }]);
    notificationUpdateMock.mockRejectedValue(new Error("evidence db failure"));

    const { sendBreakingNotification } = await import("./notification-sender");
    await expect(sendBreakingNotification({ title: "Breaking", body: "News", userId: "breaking-evidence-failure" })).resolves.toMatchObject({
      diagnostics: "push delivery evidence persistence failed",
    });
    expect(notificationCreateMock.mock.calls[0]![0].data.status).toBe("SENT");
  });

  it("persists breaking inbox before push and skips push after inbox failure", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "breaking-user",
      pushSubscriptions: [{ endpoint: "https://push.example/breaking", p256dh: "p", auth: "a", expirationTime: null }],
    }]);
    const events: string[] = [];
    notificationCreateMock.mockImplementation(async () => { events.push("inbox"); return { id: "breaking-notification" }; });
    sendPushNotificationMock.mockImplementation(async () => { events.push("push"); });

    const { sendBreakingNotification } = await import("./notification-sender");
    await sendBreakingNotification({ title: "Breaking", body: "News" });
    expect(events).toEqual(["inbox", "push"]);

    vi.clearAllMocks();
    notificationCreateMock.mockRejectedValue(new Error("inbox unavailable"));
    await sendBreakingNotification({ title: "Breaking", body: "News" });
    expect(sendPushNotificationMock).not.toHaveBeenCalled();
  });

  it("counts valid rows across a 500-row page boundary exactly once", async () => {
    userFindManyMock.mockResolvedValue([{
      id: "user-1",
      email: "one@example.com",
      notificationScheduleSlot: "MORNING",
      allowBreakingNotifications: true,
      pushSubscriptions: [],
      sourceSubscriptions: [{ sourceId: "source-1" }],
      categorySubscriptions: [],
    }]);
    const firstPage = Array.from({ length: 499 }, (_, index) => ({
      id: index + 1,
      title: `Page one ${index}`,
      canonicalUrl: `https://example.com/${index + 1}`,
      bodyText: "A".repeat(500),
    }));
    firstPage.push({
      id: 500,
      title: "   \t\n",
      canonicalUrl: "https://example.com/malformed-page-one",
      bodyText: "A".repeat(500),
    });
    articleFindManyMock
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([
        {
          id: 501,
          title: "Page two valid",
          canonicalUrl: "https://example.com/501",
          bodyText: "B".repeat(500),
        },
        {
          id: 502,
          title: "Page two short",
          canonicalUrl: "https://example.com/502",
          bodyText: "B".repeat(499),
        },
        {
          id: 503,
          title: "Page two valid",
          canonicalUrl: "https://example.com/503",
          bodyText: "C".repeat(500),
        },
      ]);

    const { sendDueDailyNotifications } = await import("./notification-sender");
    await sendDueDailyNotifications(new Date("2026-07-31T08:00:00.000Z"));

    expect(articleFindManyMock).toHaveBeenCalledTimes(2);
    expect(articleFindManyMock.mock.calls[0]![0]).toMatchObject({
      take: 500,
      orderBy: { id: "asc" },
    });
    expect(articleFindManyMock.mock.calls[1]![0]).toMatchObject({
      take: 500,
      skip: 1,
      cursor: { id: 500 },
    });
    expect(notificationCreateMock.mock.calls[0]![0].data.body).toContain("501 new articles");
  });
});
