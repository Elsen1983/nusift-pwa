import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { buildTargetFingerprint, createInspectionSnapshotToken, INSPECTION_SNAPSHOT_MAX_TOKEN_CHARS } from "../../utils/inspection-snapshot";
import type { InspectionActiveTargetResolution } from "../../utils/inspection-active-targets";
import { ADMIN_INSPECTION_POST_BODY_MAX_BYTES, parseAdminArticleInspectionBody } from "../../services/admin-inspection";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(), rateLimit: vi.fn(), articleFindMany: vi.fn(), queryRaw: vi.fn(),
  sourceFindMany: vi.fn(), categoryFindMany: vi.fn(), userFindUnique: vi.fn(),
}));
vi.mock("../../utils/require-user", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("../../utils/rate-limit", () => ({ assertRateLimit: mocks.rateLimit }));
vi.mock("../../utils/prisma", () => ({ prisma: {
  article: { findMany: mocks.articleFindMany },
  newsSource: { findMany: mocks.sourceFindMany },
  sourceCategory: { findMany: mocks.categoryFindMany },
  user: { findUnique: mocks.userFindUnique },
  $queryRaw: mocks.queryRaw,
} }));
vi.mock("h3", () => ({ defineEventHandler: (fn: any) => fn, createError: ({ statusCode, statusMessage }: any) => Object.assign(new Error(statusMessage), { statusCode, statusMessage }) }));
(globalThis as any).defineEventHandler = (handler: any) => handler;
(globalThis as any).getQuery = (event: any) => event.query || {};
(globalThis as any).readRawBody = async (event: any) => event.rawBody;

const SECRET = "snapshot-parity-secret";

const makeResolution = (overrides: Partial<InspectionActiveTargetResolution> = {}): InspectionActiveTargetResolution => ({
  sourceIds: ["s-1", "s-2"],
  categoryIds: ["c-1"],
  targets: [],
  sourceScanned: 2,
  categoryScanned: 1,
  sourceTruncated: false,
  categoryTruncated: false,
  artifactEvidenceTruncated: false,
  truncated: false,
  targetType: "ALL",
  snapshotId: "snap",
  filterFingerprint: buildTargetFingerprint("ALL"),
  ...overrides,
});

const sourceToken = () => createInspectionSnapshotToken(makeResolution());

describe("cross-endpoint inspection snapshot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.JWT_SECRET = SECRET;
    process.env.NUXT_ADMIN_EMAILS = "admin@example.com";
    mocks.requireUserId.mockReturnValue("admin");
    mocks.userFindUnique.mockResolvedValue({ email: "admin@example.com" });
    mocks.rateLimit.mockResolvedValue(undefined);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.sourceFindMany.mockResolvedValue([]);
    mocks.categoryFindMany.mockResolvedValue([]);
  });

  it("returns a signed snapshot token from source inspection", async () => {
    const sources = [{ id: "s-1", mediaName: "Source 001", frontPageUrl: "https://example.com/1", rssFeedUrl: null, rssStatus: "ACTIVE", currentFeedProductive: false, lastProductiveAt: null, nextRetryAt: null, isSystemImported: false, _count: { subscribers: 1 } }];
    const categories = [{ id: "c-1", name: "Category 001", pathUrl: "/category/1", rssFeedUrl: null, rssStatus: "ACTIVE", currentFeedProductive: false, lastProductiveAt: null, nextRetryAt: null, newsSourceId: "s-1", newsSource: { mediaName: "Source 001", frontPageUrl: "https://example.com/1", rssStatus: "ACTIVE", currentFeedProductive: false, isSystemImported: false }, _count: { subscribers: 1 } }];
    mocks.sourceFindMany.mockResolvedValue(sources);
    mocks.categoryFindMany.mockResolvedValue(categories);
    mocks.articleFindMany.mockResolvedValue([]);
    const handler = (await import("./admin-source-inspection.get")).default;
    const result = await handler({ query: { limit: "50", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" } } as any);
    expect(result.snapshotToken).toEqual(expect.any(String));
    expect(result.snapshot.available).toBe(true);
    expect(result.snapshot.targetType).toBe("ALL");
    // The active snapshot contains the subscribed source and category.
    expect(result.snapshot.sourceCount).toBe(1);
    expect(result.snapshot.categoryCount).toBe(1);
  });

  it("all-active article inspection accepts a source snapshot via POST and uses the exact IDs", async () => {
    mocks.articleFindMany.mockResolvedValue([]);
    const handler = (await import("./admin-article-inspection.post")).default;
    const result = await handler({ rawBody: JSON.stringify({ limit: "50", allActive: true, targetType: "ALL", snapshot: sourceToken(), articleState: "PUBLISHED", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" }) } as any);
    expect(result.selection.snapshotSource).toBe("client-provided");
    expect(result.selection.mode).toBe("all-active");
    expect(mocks.sourceFindMany).not.toHaveBeenCalled();
    expect(mocks.categoryFindMany).not.toHaveBeenCalled();
    const where = mocks.articleFindMany.mock.calls[0]?.[0]?.where;
    expect(where.OR).toEqual([
      { sourceId: { in: ["s-1", "s-2"] } },
      { categoryId: { in: ["c-1"] } },
    ]);
  });

  it("produces an identical target universe when article inspection reuses the source snapshot", async () => {
    const sources = Array.from({ length: 3 }, (_, index) => ({ id: `s-${index + 1}`, mediaName: `Source ${String(index + 1).padStart(3, "0")}`, frontPageUrl: `https://example.com/${index + 1}`, rssFeedUrl: null, rssStatus: "ACTIVE", currentFeedProductive: false, lastProductiveAt: null, nextRetryAt: null, isSystemImported: false, _count: { subscribers: 1 } }));
    const categories = [{ id: "c-9", name: "Category 009", pathUrl: "/category/9", rssFeedUrl: null, rssStatus: "ACTIVE", currentFeedProductive: false, lastProductiveAt: null, nextRetryAt: null, newsSourceId: "s-1", newsSource: { mediaName: "Source 001", frontPageUrl: "https://example.com/1", rssStatus: "ACTIVE", currentFeedProductive: false, isSystemImported: false }, _count: { subscribers: 1 } }];
    mocks.sourceFindMany.mockResolvedValue(sources);
    mocks.categoryFindMany.mockResolvedValue(categories);
    mocks.articleFindMany.mockResolvedValue([]);
    const sourceHandler = (await import("./admin-source-inspection.get")).default;
    const sourceResult = await sourceHandler({ query: { limit: "50", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" } } as any);
    expect(sourceResult.snapshotToken).toEqual(expect.any(String));

    const articleHandler = (await import("./admin-article-inspection.post")).default;
    await articleHandler({ rawBody: JSON.stringify({ limit: "50", allActive: true, targetType: "ALL", snapshot: sourceResult.snapshotToken, dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" }) } as any);
    const where = mocks.articleFindMany.mock.calls[0]?.[0]?.where;
    // The exact active IDs resolved by source inspection become the article
    // universe — no independent re-resolution.
    expect(where.OR).toEqual([
      { sourceId: { in: ["s-1", "s-2", "s-3"] } },
      { categoryId: { in: ["c-9"] } },
    ]);
  });

  it("rejects malformed, expired, modified, wrong-target and wrong-filter snapshots with 400", async () => {
    mocks.articleFindMany.mockResolvedValue([]);
    const handler = (await import("./admin-article-inspection.post")).default;
    const base = { limit: "50", allActive: true, targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" };

    await expect(handler({ rawBody: JSON.stringify({ ...base, snapshot: "garbage" }) } as any)).rejects.toMatchObject({ statusCode: 400 });
    await expect(handler({ rawBody: JSON.stringify({ ...base, snapshot: "" }) } as any)).resolves.toMatchObject({ selection: { snapshotSource: "independent" } });

    // Wrong target type: token for SOURCE used in ALL mode.
    const sourceBound = createInspectionSnapshotToken(makeResolution({ targetType: "SOURCE" as const, filterFingerprint: buildTargetFingerprint("SOURCE") }));
    await expect(handler({ rawBody: JSON.stringify({ ...base, snapshot: sourceBound }) } as any)).rejects.toMatchObject({ statusCode: 400 });

    // Wrong filter: token fingerprint bound to a different target type.
    const categoryBound = createInspectionSnapshotToken(makeResolution({ targetType: "CATEGORY" as const, filterFingerprint: buildTargetFingerprint("CATEGORY") }));
    await expect(handler({ rawBody: JSON.stringify({ ...base, snapshot: categoryBound }) } as any)).rejects.toMatchObject({ statusCode: 400 });

    // Modified payload (tampered active IDs).
    const parts = sourceToken().split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    payload.sourceIds = ["attacker-id"];
    const modified = [parts[0]!, Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"), parts[2]!].join(".");
    await expect(handler({ rawBody: JSON.stringify({ ...base, snapshot: modified }) } as any)).rejects.toMatchObject({ statusCode: 400 });

    // Expired token.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const expired = createInspectionSnapshotToken(makeResolution(), past);
    await expect(handler({ rawBody: JSON.stringify({ ...base, snapshot: expired }) } as any)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("generates an independent snapshot when none is supplied and reports it truthfully", async () => {
    mocks.sourceFindMany.mockResolvedValue([]);
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.articleFindMany.mockResolvedValue([]);
    const handler = (await import("./admin-article-inspection.get")).default;
    const result = await handler({ query: { limit: "50", allActive: "true", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" } } as any);
    expect(result.selection.snapshotSource).toBe("independent");
    expect(result.snapshotToken).toEqual(expect.any(String));
    expect(result.snapshot?.available).toBe(true);
  });

  it("does not require a snapshot for explicit target inspection", async () => {
    mocks.articleFindMany.mockResolvedValue([]);
    const handler = (await import("./admin-article-inspection.get")).default;
    const result = await handler({ query: { limit: "50", targetIds: "s-1,s-2", targetType: "SOURCE", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" } } as any);
    expect(result.selection.mode).toBe("explicit");
    expect(result.selection.snapshotSource).toBe("none");
    expect(result.snapshot).toBeNull();
    expect(mocks.sourceFindMany).not.toHaveBeenCalled();
  });

  it("refuses snapshot tokens on the GET endpoint (POST is the safe transport)", async () => {
    mocks.articleFindMany.mockResolvedValue([]);
    const handler = (await import("./admin-article-inspection.get")).default;
    await expect(handler({ query: { limit: "50", allActive: "true", targetType: "ALL", snapshot: sourceToken() } } as any)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("lets article display filters change without invalidating the snapshot", async () => {
    mocks.articleFindMany.mockResolvedValue([]);
    const handler = (await import("./admin-article-inspection.post")).default;
    const base = { limit: "50", allActive: true, targetType: "ALL", snapshot: sourceToken(), dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" };
    const plain = await handler({ rawBody: JSON.stringify(base) } as any);
    expect(plain.selection.snapshotSource).toBe("client-provided");
    const withState = await handler({ rawBody: JSON.stringify({ ...base, articleState: "REJECTED", pipelineStage: "AGENT2", search: "breaking", dateFrom: "2026-08-02T00:00:00.000Z" }) } as any);
    expect(withState.selection.snapshotSource).toBe("client-provided");
  });

  it("worst-case UUID-like IDs at the maximum supported universe fit the bounded POST transport", async () => {
    const uuid = () => randomUUID();
    const sourceIds = Array.from({ length: 500 }, uuid);
    const categoryIds = Array.from({ length: 500 }, uuid);
    const maxResolution = makeResolution({ sourceIds, categoryIds, sourceScanned: 500, categoryScanned: 500 });
    const token = createInspectionSnapshotToken(maxResolution);
    // The token must fit the parse/creation cap...
    expect(token.length).toBeLessThanOrEqual(INSPECTION_SNAPSHOT_MAX_TOKEN_CHARS);
    // ...and a body carrying it must fit the conservative 64 KB transport cap.
    const body = JSON.stringify({ limit: "50", allActive: true, targetType: "ALL", snapshot: token });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(ADMIN_INSPECTION_POST_BODY_MAX_BYTES);
    expect(() => parseAdminArticleInspectionBody(body)).not.toThrow();

    mocks.articleFindMany.mockResolvedValue([]);
    const handler = (await import("./admin-article-inspection.post")).default;
    const result = await handler({ rawBody: body } as any);
    expect(result.selection.snapshotSource).toBe("client-provided");
    const where = mocks.articleFindMany.mock.calls[0]?.[0]?.where;
    expect(where.OR[0].sourceId.in).toHaveLength(500);
    expect(where.OR[1].categoryId.in).toHaveLength(500);
  });

  it("refuses to mint a token above the transport cap (creation-side guard)", () => {
    // Both streams at the per-list bound: ~78 KB of JSON → ~104 KB base64url
    // token, which the bounded POST transport could not carry.
    const sourceIds = Array.from({ length: 1_000 }, () => randomUUID());
    const categoryIds = Array.from({ length: 1_000 }, () => randomUUID());
    const resolution = makeResolution({ sourceIds, categoryIds, sourceScanned: 1_000, categoryScanned: 1_000 });
    expect(() => createInspectionSnapshotToken(resolution)).toThrow(/transport size limit/i);
  });
});
