import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(), rateLimit: vi.fn(), articleFindMany: vi.fn(), artifactFindMany: vi.fn(), articleFindUnique: vi.fn(), queryRaw: vi.fn(), userFindUnique: vi.fn(), sourceFindMany: vi.fn(), categoryFindMany: vi.fn(),
}));
vi.mock("../../utils/require-user", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("../../utils/rate-limit", () => ({ assertRateLimit: mocks.rateLimit }));
vi.mock("../../utils/prisma", () => ({ prisma: { $queryRaw: mocks.queryRaw, article: { findMany: mocks.articleFindMany, findUnique: mocks.articleFindUnique }, pipelineArtifact: { findMany: mocks.artifactFindMany }, newsSource: { findMany: mocks.sourceFindMany }, sourceCategory: { findMany: mocks.categoryFindMany }, user: { findUnique: mocks.userFindUnique } } }));
vi.mock("h3", () => ({ defineEventHandler: (fn: any) => fn, createError: ({ statusCode, statusMessage }: any) => Object.assign(new Error(statusMessage), { statusCode, statusMessage }) }));
(globalThis as any).defineEventHandler = (handler: any) => handler;
(globalThis as any).getQuery = (event: any) => event.query || {};
(globalThis as any).getRouterParam = (event: any, name: string) => event.params?.[name];
(globalThis as any).readRawBody = async (event: any) => event.rawBody;

describe("Prompt 13A inspection endpoint behavior", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NUXT_ADMIN_EMAILS = "admin@example.com";
    mocks.requireUserId.mockReturnValue("admin");
    mocks.userFindUnique.mockResolvedValue({ email: "admin@example.com" });
    mocks.rateLimit.mockResolvedValue(undefined);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.sourceFindMany.mockResolvedValue([]);
    mocks.categoryFindMany.mockResolvedValue([]);
  });

  it("rejects invalid article filters and safely handles an empty explicit selection", async () => {
    const handler = (await import("./admin-article-inspection.get")).default;
    await expect(handler({ query: { targetIds: "source-1", articleState: "bogus" } } as any)).rejects.toMatchObject({ statusCode: 400 });
    await expect(handler({ query: {} } as any)).resolves.toMatchObject({ selection: { targetCount: 0 }, items: [] });
    expect(mocks.articleFindMany).not.toHaveBeenCalled();
  });

  it("returns a bounded body preview and uses canonical publication validation", async () => {
    const article = { id: 1, title: "Valid", bodyText: "\u0000  long text ".repeat(100), sourceId: "source-1", categoryId: null, sourceUrl: "https://example.com/source?secret=yes", canonicalUrl: "https://example.com/a?token=secret", publishedAt: null, date: new Date("2026-08-01T00:00:00Z"), createdAt: new Date("2026-08-01T00:00:00Z"), publicationStatus: "PUBLISHED", publicationStage: "agent3", publicationReadyAt: new Date("2026-08-01T00:00:00Z"), enrichmentStatus: "ENRICHED", enrichmentOutcome: {}, processingStage: "INGESTED", processingStatus: "SUCCESS", isPaywall: false, source: { mediaName: "Source", frontPageUrl: "https://example.com" }, category: null };
    mocks.articleFindMany.mockResolvedValueOnce([article]).mockResolvedValueOnce([]);
    mocks.artifactFindMany.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([{ id: 1, bodyPresent: true, bodyLength: 600, bodyPrefix: "long text ".repeat(52) }]);
    const handler = (await import("./admin-article-inspection.get")).default;
    const result = await handler({ query: { targetIds: "source-1", targetType: "SOURCE", limit: "1" } } as any);
    expect(result.items[0]?.durableState).toBe("PUBLISHED");
    expect(result.items[0]?.bodyPreview.length).toBeLessThanOrEqual(320);
    expect(result.items[0]?.canonicalUrl).toBe("https://example.com/a");
    expect(result.items[0]?.bodyPreview).not.toContain("\u0000");
  });

  it("returns sanitized bounded detail evidence and body preview", async () => {
    mocks.articleFindUnique.mockResolvedValue({ id: 2, title: "Article", bodyText: "A".repeat(500), sourceId: "s", categoryId: null, sourceUrl: "https://example.com/a?x=1", canonicalUrl: "https://example.com/a?secret=2", publishedAt: null, date: new Date(), createdAt: new Date(), publicationStatus: "PROCESSING", publicationStage: "agent3", publicationReadyAt: null, enrichmentStatus: "ENRICHING", enrichmentOutcome: {}, processingStage: "INGESTED", processingStatus: "SUCCESS", isPaywall: false, source: { mediaName: "S", frontPageUrl: "https://example.com" }, category: null });
    mocks.queryRaw.mockResolvedValue([{ id: "artifact", createdAt: new Date(), artifactType: "article_enrichment_result", status: "CAPTURED", articleId: "2", kind: "SUCCESS", rejectionCode: null, rejectionDetail: null, retryAfterAt: null, browserFallback: null, retryDiagnostics: null, failureReason: null, errorLog: null }]);
    const handler = (await import("./admin-article-inspection/[id].get")).default;
    const result = await handler({ params: { id: "2" } } as any);
    expect(result.item.canonicalUrl).toBe("https://example.com/a");
    expect(result.item.bodyPreview).toHaveLength(320);
    expect(result.item.evidenceTimeline[0]?.type).toBe("article_enrichment_result");
  });

  it("POST endpoint carries all-active snapshot params through the bounded body and forces all-active", async () => {
    mocks.articleFindMany.mockResolvedValue([]);
    const handler = (await import("./admin-article-inspection.post")).default;
    const result = await handler({ rawBody: JSON.stringify({ limit: "50", targetType: "ALL", articleState: "PUBLISHED" }) } as any);
    expect(result.selection.mode).toBe("all-active");
    expect(result.selection.snapshotSource).toBe("independent");
    expect(mocks.articleFindMany).toHaveBeenCalled();
  });

  it("POST endpoint rejects explicit target selection and empty bodies", async () => {
    const handler = (await import("./admin-article-inspection.post")).default;
    await expect(handler({ rawBody: JSON.stringify({ targetIds: "source-1", targetType: "SOURCE" }) } as any)).rejects.toMatchObject({ statusCode: 400 });
    await expect(handler({ rawBody: JSON.stringify({ allActive: false, limit: "50" }) } as any)).rejects.toMatchObject({ statusCode: 400 });
    await expect(handler({ rawBody: "" } as any)).rejects.toMatchObject({ statusCode: 400 });
    await expect(handler({ rawBody: "{not-json" } as any)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("POST endpoint rejects oversized content-length headers with 413 before buffering", async () => {
    const handler = (await import("./admin-article-inspection.post")).default;
    await expect(handler({ headers: { get: () => "70000" }, rawBody: "{}" } as any)).rejects.toMatchObject({ statusCode: 413 });
  });

  it("POST endpoint rejects oversized bodies with 413 before application parsing", async () => {
    const { ADMIN_INSPECTION_POST_BODY_MAX_BYTES, parseAdminArticleInspectionBody } = await import("../../services/admin-inspection");
    const oversized = JSON.stringify({ snapshot: "x".repeat(ADMIN_INSPECTION_POST_BODY_MAX_BYTES + 1) });
    expect(() => parseAdminArticleInspectionBody(oversized)).toThrow(expect.objectContaining({ statusCode: 413 }));
    const handler = (await import("./admin-article-inspection.post")).default;
    await expect(handler({ rawBody: oversized } as any)).rejects.toMatchObject({ statusCode: 413 });
  });
});
