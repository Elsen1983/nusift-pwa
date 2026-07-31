import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userFindManyMock = vi.hoisted(() => vi.fn());
const notificationFindFirstMock = vi.hoisted(() => vi.fn());
const notificationCreateMock = vi.hoisted(() => vi.fn());
const articleFindManyMock = vi.hoisted(() => vi.fn());

vi.mock("./prisma", () => ({
  prisma: {
    user: { findMany: userFindManyMock },
    notification: {
      findFirst: notificationFindFirstMock,
      create: notificationCreateMock,
    },
    article: { findMany: articleFindManyMock },
    pushSubscription: { update: vi.fn() },
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
  sendPushNotification: vi.fn(),
}));

describe("sendDueDailyNotifications", () => {
  beforeEach(() => {
    delete process.env.NUXT_PIPELINE_TERMINAL_STAGE;
    vi.clearAllMocks();
    notificationFindFirstMock.mockResolvedValue(null);
    notificationCreateMock.mockResolvedValue({});
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

  it("does not count global articles for a user without active subscriptions", async () => {
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
    expect(notificationCreateMock.mock.calls[0]![0].data.body).toBe("Your daily news update is ready.");
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
