import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAndParseMock = vi.hoisted(() => vi.fn());
const fetchResponseMock = vi.hoisted(() => vi.fn());

vi.mock("../prisma", () => ({ prisma: {} }));
vi.mock("./governed-fetch", () => ({
  governedSafeFetchAndParse: async (url: string, options: unknown, context: unknown, parse: (response: unknown) => Promise<unknown>) => {
    fetchAndParseMock(url, options, context, parse);
    return parse(await fetchResponseMock());
  },
  GovernedFetchDeferredError: class GovernedFetchDeferredError extends Error {
    readonly reason: string;
    constructor(reason: string) { super(reason); this.reason = reason; }
  },
}));

const NOW = new Date("2026-08-10T12:00:00.000Z");

const makeDb = () => {
  let row: any = null;
  const apply = (data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (key === "version" && typeof value === "object" && value !== null && "increment" in value) {
        row.version += Number((value as { increment: number }).increment);
      } else row[key] = value;
    }
  };
  const matches = (where: Record<string, unknown>) => {
    if (!row || where.domainKey !== row.domainKey || where.version !== row.version) return false;
    if (where.activeLeaseToken === null && row.activeLeaseToken !== null) return false;
    if (where.activeLeaseToken && where.activeLeaseToken !== row.activeLeaseToken) return false;
    const ors = where.OR as Array<Record<string, unknown>> | undefined;
    if (ors && !ors.some((candidate) => {
      if (candidate.activeLeaseToken === null) return row.activeLeaseToken === null;
      if (candidate.activeLeaseExpiresAt === null) return row.activeLeaseExpiresAt === null;
      const lte = (candidate.activeLeaseExpiresAt as { lte?: Date }).lte;
      return Boolean(lte && row.activeLeaseExpiresAt && row.activeLeaseExpiresAt <= lte);
    })) return false;
    return true;
  };
  const model = {
    findUnique: vi.fn(async () => row && { ...row }),
    create: vi.fn(async ({ data }: any) => {
      if (row) throw { code: "P2002" };
      row = {
        ...data,
        httpStatus: null,
        lastDecision: null,
        lastDecisionAt: null,
        activeLeaseToken: null,
        activeLeaseExpiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!matches(where)) return { count: 0 };
      apply(data);
      return { count: 1 };
    }),
  };
  return { db: { publisherRobotsPolicy: model }, model, getRow: () => row };
};

const context = () => ({
  agent: "agent2" as const,
  stage: "test",
  purpose: "article_detail" as const,
  mode: "off" as const,
});

describe("publisher robots policy", () => {
  beforeEach(() => {
    fetchAndParseMock.mockReset();
    fetchResponseMock.mockReset();
  });

  it("applies exact user-agent groups and longest Allow precedence", async () => {
    const { parseRobotsTxt, isRobotsUrlAllowed } = await import("./robots-policy");
    const parsed = parseRobotsTxt([
      "User-agent: *",
      "Disallow: /private",
      "Allow: /private/public",
      "",
      "User-agent: NuSiftBot",
      "Disallow: /internal",
    ].join("\n"));
    expect(isRobotsUrlAllowed(parsed, "https://example.com/private/public", "OtherBot")).toBe(true);
    expect(isRobotsUrlAllowed(parsed, "https://example.com/private/secret", "OtherBot")).toBe(false);
    expect(isRobotsUrlAllowed(parsed, "https://example.com/internal")).toBe(false);
    expect(isRobotsUrlAllowed(parsed, "https://example.com/news")).toBe(true);
  });

  it("supports wildcard and end-of-path rules", async () => {
    const { parseRobotsTxt, isRobotsUrlAllowed } = await import("./robots-policy");
    const parsed = parseRobotsTxt("User-agent: *\nDisallow: /*?print=\nDisallow: /exact$\n");
    expect(isRobotsUrlAllowed(parsed, "https://example.com/news?print=1", "OtherBot")).toBe(false);
    expect(isRobotsUrlAllowed(parsed, "https://example.com/news?print=1&x=2", "OtherBot")).toBe(false);
    expect(isRobotsUrlAllowed(parsed, "https://example.com/exact", "OtherBot")).toBe(false);
    expect(isRobotsUrlAllowed(parsed, "https://example.com/exact/more", "OtherBot")).toBe(true);
  });

  it("keeps malformed and oversized inputs bounded", async () => {
    const { parseRobotsTxt, ROBOTS_MAX_BODY_BYTES } = await import("./robots-policy");
    expect(parseRobotsTxt("<html>not robots</html>").malformed).toBe(true);
    expect(ROBOTS_MAX_BODY_BYTES).toBe(64 * 1024);
  });

  it("fetches once, caches parsed rules, and stores no raw body", async () => {
    const { checkPublisherRobotsAccess } = await import("./robots-policy");
    const { NUSIFT_CRAWLER_USER_AGENT } = await import("./publisher-user-agent");
    const fixture = makeDb();
    fetchResponseMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      text: async () => "User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml\n# SECRET_BODY_MUST_NOT_PERSIST",
    });
    const first = await checkPublisherRobotsAccess("https://example.com/news", { db: fixture.db, context: context(), now: NOW });
    const second = await checkPublisherRobotsAccess("https://example.com/private/story", { db: fixture.db, context: context(), now: new Date(NOW.getTime() + 1_000) });
    expect(first.decision).toBe("allowed");
    expect(second.decision).toBe("disallowed");
    expect(fetchAndParseMock).toHaveBeenCalledTimes(1);
    expect(fetchAndParseMock.mock.calls[0]?.[1].headers["User-Agent"]).toBe(NUSIFT_CRAWLER_USER_AGENT);
    expect(JSON.stringify(fixture.getRow())).not.toContain("SECRET_BODY_MUST_NOT_PERSIST");
    expect(fixture.getRow().rules.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("refreshes an expired entry and suppresses a concurrent stampede", async () => {
    const { checkPublisherRobotsAccess } = await import("./robots-policy");
    const fixture = makeDb();
    let releaseFetch!: () => void;
    const fetchBlocked = new Promise<void>((resolve) => { releaseFetch = resolve; });
    fetchResponseMock.mockImplementation(async () => {
      await fetchBlocked;
      return { status: 200, ok: true, headers: new Headers(), text: async () => "User-agent: *\nDisallow: /private" };
    });
    const firstPromise = checkPublisherRobotsAccess("https://example.com/news", { db: fixture.db, context: context(), now: NOW });
    await Promise.resolve();
    const second = await checkPublisherRobotsAccess("https://example.com/news", { db: fixture.db, context: context(), now: NOW });
    expect(second.decision).toBe("deferred");
    expect(fetchAndParseMock).toHaveBeenCalledTimes(1);
    releaseFetch();
    await expect(firstPromise).resolves.toMatchObject({ decision: "allowed" });
  });

  it("treats robots 429 as deferred and robots 403 as allowed, never as paywall", async () => {
    const { checkPublisherRobotsAccess } = await import("./robots-policy");
    const rateLimited = makeDb();
    fetchResponseMock.mockResolvedValueOnce({
      status: 429, ok: false, headers: new Headers({ "retry-after": "60" }),
    });
    await expect(checkPublisherRobotsAccess("https://rate.example.com/news", { db: rateLimited.db, context: context(), now: NOW }))
      .resolves.toMatchObject({ decision: "deferred", reason: "robots_rate_limited" });

    const forbidden = makeDb();
    const recordAccessDenied = vi.fn();
    fetchResponseMock.mockResolvedValueOnce({
      status: 403, ok: false, headers: new Headers(),
    });
    await expect(checkPublisherRobotsAccess("https://forbidden.example.com/news", {
      db: forbidden.db,
      context: {
        ...context(),
        requestBudget: { consume: vi.fn(() => true), recordAccessDenied },
      },
      now: NOW,
    }))
      .resolves.toMatchObject({ decision: "allowed", status: "forbidden" });
    expect(recordAccessDenied).toHaveBeenCalledWith(
      "robots",
      "https://forbidden.example.com/robots.txt",
    );
  });
});
