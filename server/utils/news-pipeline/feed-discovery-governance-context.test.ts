import { beforeEach, describe, expect, it, vi } from "vitest";

const capturedContexts = vi.hoisted(() => vi.fn());
const governedSafeFetchAndParseMock = vi.hoisted(() => vi.fn());

const responseFor = (url: string, method?: string) => {
  const status = method === "HEAD" ? 404 : 404;
  return {
    ok: false,
    status,
    url,
    headers: new Headers(),
    text: async () => "",
  } as unknown as Response;
};

vi.mock("./governed-fetch", () => ({
  GovernedFetchDeferredError: class GovernedFetchDeferredError extends Error {},
  governedSafeFetch: vi.fn(async (url: string, options: { method?: string } | undefined, context: unknown) => {
    capturedContexts(context);
    return responseFor(url, options?.method);
  }),
  governedSafeFetchAndParse: governedSafeFetchAndParseMock,
}));

describe("feed discovery governance context", () => {
  beforeEach(() => {
    capturedContexts.mockReset();
    governedSafeFetchAndParseMock.mockReset();
    governedSafeFetchAndParseMock.mockImplementation(async (
      url: string,
      options: { method?: string } | undefined,
      context: unknown,
      parse: (response: Response) => Promise<unknown>,
    ) => {
      capturedContexts(context);
      return parse(responseFor(url, options?.method));
    });
  });

  it("preserves Agent 1 context across governed feed-discovery requests", async () => {
    const { discoverFeedForUrl } = await import("./feed-discovery");

    await discoverFeedForUrl({
      pageUrl: "https://example.com/news",
      userAgent: "NuSift-Test",
      governedFetchContext: {
        agent: "agent1",
        stage: "ingest",
        purpose: "feed",
        sourceId: "source-1",
        categoryId: "category-1",
        pipelineRunId: "run-1",
        mode: "shadow",
      },
    });

    expect(capturedContexts).toHaveBeenCalled();
    for (const [context] of capturedContexts.mock.calls) {
      expect(context).toMatchObject({
        agent: "agent1",
        stage: "feed-discovery",
        sourceId: "source-1",
        categoryId: "category-1",
        pipelineRunId: "run-1",
        mode: "shadow",
      });
      expect(["feed", "listing", "robots", "sitemap"]).toContain(context.purpose);
    }
  });

  it("preserves Agent 2 context across successful feed verification and directory traversal", async () => {
    governedSafeFetchAndParseMock.mockImplementation(async (
      url: string,
      _options: { method?: string } | undefined,
      context: any,
      parse: (response: Response) => Promise<unknown>,
    ) => {
      capturedContexts(context);
      const isDirectory = url.endsWith("/rss-directory");
      const isVerifiedFeed = url.endsWith("/feeds/arizona.xml");
      const isMainPage = url === "https://example.com/news/arizona";
      const directoryHtml = [
        '<a href="/feeds/arizona.xml">Arizona</a>',
        '<a href="/feeds/sport.xml">Sport</a>',
        '<a href="/feeds/business.xml">Business</a>',
        '<a href="/feeds/world.xml">World</a>',
        '<a href="/feeds/tech.xml">Technology</a>',
      ].join("");
      const mainHtml = '<a href="/rss-directory">RSS directory</a>';
      const response = {
        ok: isDirectory || isVerifiedFeed || isMainPage,
        status: isDirectory || isVerifiedFeed || isMainPage ? 200 : 404,
        url,
        headers: new Headers(isVerifiedFeed ? { "content-type": "application/rss+xml" } : { "content-type": "text/html" }),
        text: async () => isDirectory ? directoryHtml : isMainPage ? mainHtml : isVerifiedFeed ? "<rss><channel><item /></channel></rss>" : "",
      } as unknown as Response;
      return parse(response);
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/news/arizona",
      userAgent: "NuSift-Test",
      governedFetchContext: {
        agent: "agent2",
        stage: "article-discovery",
        purpose: "listing",
        sourceId: "source-2",
        categoryId: "category-2",
        pipelineRunId: "run-2",
        mode: "shadow",
      },
    });

    expect(result.feedUrl).toBe("https://example.com/feeds/arizona.xml");
    expect(result.detection).toBe("directory-traversal");
    expect(capturedContexts.mock.calls.some(([context]) =>
      context.agent === "agent2" &&
      context.pipelineRunId === "run-2" &&
      context.mode === "shadow" &&
      context.purpose === "listing",
    )).toBe(true);
    expect(capturedContexts.mock.calls.some(([context]) =>
      context.agent === "agent2" &&
      context.pipelineRunId === "run-2" &&
      context.mode === "shadow" &&
      context.purpose === "feed",
    )).toBe(true);
  });

  it("preserves Agent 2 context across governed feed-discovery requests", async () => {
    const { discoverFeedForUrl } = await import("./feed-discovery");

    await discoverFeedForUrl({
      pageUrl: "https://example.com/news",
      userAgent: "NuSift-Test",
      governedFetchContext: {
        agent: "agent2",
        stage: "article-discovery",
        purpose: "listing",
        sourceId: "source-2",
        categoryId: null,
        mode: "shadow",
      },
    });

    expect(capturedContexts).toHaveBeenCalled();
    for (const [context] of capturedContexts.mock.calls) {
      expect(context).toMatchObject({
        agent: "agent2",
        stage: "feed-discovery",
        sourceId: "source-2",
        categoryId: null,
        mode: "shadow",
      });
      expect(["feed", "listing", "robots", "sitemap"]).toContain(context.purpose);
    }
  });
});
