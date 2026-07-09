import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Provide Nitro auto-imports via globalThis
// ---------------------------------------------------------------------------
const mockReadBody = vi.fn();
const mockGetRouterParam = vi.fn();
const mockRequireAdminId = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;
(globalThis as any).readBody = (...args: any[]) => mockReadBody(...args);
(globalThis as any).getRouterParam = (...args: any[]) =>
  mockGetRouterParam(...args);
(globalThis as any).createError = ({
  statusCode,
  statusMessage,
}: {
  statusCode: number;
  statusMessage: string;
}) => {
  const err = new Error(statusMessage) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
const feedReviewFindUniqueMock = vi.fn();
const feedReviewUpdateMock = vi.fn();
const newsSourceUpdateMock = vi.fn();
const sourceCategoryUpdateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  createError: ({
    statusCode,
    statusMessage,
  }: {
    statusCode: number;
    statusMessage: string;
  }) => {
    const err = new Error(statusMessage) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
  },
}));

vi.mock("../../../utils/prisma", () => ({
  prisma: {
    feedReviewRequest: {
      findUnique: (...args: any[]) => feedReviewFindUniqueMock(...args),
      update: (...args: any[]) => feedReviewUpdateMock(...args),
    },
    newsSource: {
      update: (...args: any[]) => newsSourceUpdateMock(...args),
    },
    sourceCategory: {
      update: (...args: any[]) => sourceCategoryUpdateMock(...args),
    },
    $transaction: (...args: any[]) => transactionMock(...args),
  },
}));

vi.mock("../../../utils/require-admin", () => ({
  requireAdminId: (...args: any[]) => mockRequireAdminId(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up router param mock to return `id` for the "id" param */
function mockRouteParam(id: string) {
  mockGetRouterParam.mockImplementation((_event: any, param: string) => {
    if (param === "id") return id;
    return undefined;
  });
}

const OPEN_SOURCE_REQUEST = {
  id: "req-1",
  status: "OPEN",
  sourceId: "src-1",
  categoryId: null,
  targetType: "SOURCE",
};

const OPEN_CATEGORY_REQUEST = {
  id: "req-2",
  status: "OPEN",
  sourceId: null,
  categoryId: "cat-1",
  targetType: "CATEGORY",
};

const RESOLVED_REQUEST = {
  id: "req-3",
  status: "AUTO_RESOLVED_VALIDATED",
  sourceId: "src-1",
  categoryId: null,
  targetType: "SOURCE",
};

// ---------------------------------------------------------------------------
// Tests – PATCH /api/dev/review-requests/:id
// ---------------------------------------------------------------------------
describe("PATCH /api/dev/review-requests/:id", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdminId.mockResolvedValue("admin-1");
    // Default: $transaction resolves an array of promises
    transactionMock.mockImplementation(async (ops: any[]) => {
      return Promise.all(ops);
    });
  });

  async function loadHandler() {
    const mod = await import("../../../api/dev/review-requests/[id].patch");
    return mod.default;
  }

  // -- route param usage ------------------------------------------------

  it("uses the route param id (not body.requestId)", async () => {
    mockRouteParam("req-1");
    feedReviewFindUniqueMock.mockResolvedValue(OPEN_SOURCE_REQUEST);
    feedReviewUpdateMock.mockResolvedValue({
      id: "req-1",
      status: "RESOLVED_BY_ADMIN",
      resolvedAt: new Date(),
      resolvedByUserId: "admin-1",
    });
    mockReadBody.mockResolvedValue({ action: "RESOLVED_BY_ADMIN" });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(feedReviewFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "req-1" },
      select: expect.any(Object),
    });
    expect(feedReviewUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "req-1" } }),
    );
  });

  it("rejects with 400 when route param id is missing", async () => {
    mockGetRouterParam.mockReturnValue(undefined);
    mockReadBody.mockResolvedValue({ action: "RESOLVED_BY_ADMIN" });

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 400 });
  });

  // -- basic resolve / dismiss -----------------------------------------

  it("resolves an OPEN source request as RESOLVED_BY_ADMIN", async () => {
    mockRouteParam("req-1");
    feedReviewFindUniqueMock.mockResolvedValue(OPEN_SOURCE_REQUEST);
    feedReviewUpdateMock.mockResolvedValue({
      id: "req-1",
      status: "RESOLVED_BY_ADMIN",
      resolvedAt: new Date("2026-01-01"),
      resolvedByUserId: "admin-1",
    });
    mockReadBody.mockResolvedValue({ action: "RESOLVED_BY_ADMIN" });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.reviewRequest.status).toBe("RESOLVED_BY_ADMIN");
    expect(result.reviewRequest.resolvedByUserId).toBe("admin-1");
    expect(result.feedProvenanceUpdated).toBe(false);
    // No provenance update => $transaction should NOT be called
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("dismisses an OPEN request as DISMISSED", async () => {
    mockRouteParam("req-2");
    feedReviewFindUniqueMock.mockResolvedValue(OPEN_CATEGORY_REQUEST);
    feedReviewUpdateMock.mockResolvedValue({
      id: "req-2",
      status: "DISMISSED",
      resolvedAt: new Date(),
      resolvedByUserId: "admin-1",
    });
    mockReadBody.mockResolvedValue({ action: "DISMISSED" });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.reviewRequest.status).toBe("DISMISSED");
    expect(result.feedProvenanceUpdated).toBe(false);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  // -- non-OPEN rejection ----------------------------------------------

  it("rejects a non-OPEN request with 409", async () => {
    mockRouteParam("req-3");
    feedReviewFindUniqueMock.mockResolvedValue(RESOLVED_REQUEST);
    mockReadBody.mockResolvedValue({ action: "RESOLVED_BY_ADMIN" });

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 409 });
    expect(feedReviewUpdateMock).not.toHaveBeenCalled();
  });

  // -- confirmFeed ------------------------------------------------------

  it("updates source provenance to ADMIN_CONFIRMED when confirmFeed=true", async () => {
    mockRouteParam("req-1");
    feedReviewFindUniqueMock.mockResolvedValue(OPEN_SOURCE_REQUEST);
    newsSourceUpdateMock.mockResolvedValue({});
    feedReviewUpdateMock.mockResolvedValue({
      id: "req-1",
      status: "RESOLVED_BY_ADMIN",
      resolvedAt: new Date(),
      resolvedByUserId: "admin-1",
    });
    mockReadBody.mockResolvedValue({
      action: "RESOLVED_BY_ADMIN",
      confirmFeed: true,
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.feedProvenanceUpdated).toBe(true);
    expect(newsSourceUpdateMock).toHaveBeenCalledWith({
      where: { id: "src-1" },
      data: { feedProvenance: "ADMIN_CONFIRMED" },
    });
    expect(transactionMock).toHaveBeenCalled();
  });

  it("updates category provenance to ADMIN_CONFIRMED when confirmFeed=true", async () => {
    mockRouteParam("req-2");
    feedReviewFindUniqueMock.mockResolvedValue(OPEN_CATEGORY_REQUEST);
    sourceCategoryUpdateMock.mockResolvedValue({});
    feedReviewUpdateMock.mockResolvedValue({
      id: "req-2",
      status: "RESOLVED_BY_ADMIN",
      resolvedAt: new Date(),
      resolvedByUserId: "admin-1",
    });
    mockReadBody.mockResolvedValue({
      action: "RESOLVED_BY_ADMIN",
      confirmFeed: true,
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.feedProvenanceUpdated).toBe(true);
    expect(sourceCategoryUpdateMock).toHaveBeenCalledWith({
      where: { id: "cat-1" },
      data: { feedProvenance: "ADMIN_CONFIRMED" },
    });
  });

  // -- revertProvenance -------------------------------------------------

  it("resets source provenance and clears submitted fields when revertProvenance=true", async () => {
    mockRouteParam("req-1");
    feedReviewFindUniqueMock.mockResolvedValue(OPEN_SOURCE_REQUEST);
    newsSourceUpdateMock.mockResolvedValue({});
    feedReviewUpdateMock.mockResolvedValue({
      id: "req-1",
      status: "RESOLVED_BY_ADMIN",
      resolvedAt: new Date(),
      resolvedByUserId: "admin-1",
    });
    mockReadBody.mockResolvedValue({
      action: "RESOLVED_BY_ADMIN",
      revertProvenance: true,
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.feedProvenanceUpdated).toBe(true);
    expect(newsSourceUpdateMock).toHaveBeenCalledWith({
      where: { id: "src-1" },
      data: {
        feedProvenance: "SYSTEM_DISCOVERED",
        feedSubmittedByUserId: null,
        feedSubmittedAt: null,
      },
    });
  });

  it("resets category provenance and clears submitted fields when revertProvenance=true", async () => {
    mockRouteParam("req-2");
    feedReviewFindUniqueMock.mockResolvedValue(OPEN_CATEGORY_REQUEST);
    sourceCategoryUpdateMock.mockResolvedValue({});
    feedReviewUpdateMock.mockResolvedValue({
      id: "req-2",
      status: "DISMISSED",
      resolvedAt: new Date(),
      resolvedByUserId: "admin-1",
    });
    mockReadBody.mockResolvedValue({
      action: "DISMISSED",
      revertProvenance: true,
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.feedProvenanceUpdated).toBe(true);
    expect(sourceCategoryUpdateMock).toHaveBeenCalledWith({
      where: { id: "cat-1" },
      data: {
        feedProvenance: "SYSTEM_DISCOVERED",
        feedSubmittedByUserId: null,
        feedSubmittedAt: null,
      },
    });
  });

  // -- mutual exclusion -------------------------------------------------

  it("rejects with 400 when both confirmFeed and revertProvenance are true", async () => {
    mockRouteParam("req-1");
    mockReadBody.mockResolvedValue({
      action: "RESOLVED_BY_ADMIN",
      confirmFeed: true,
      revertProvenance: true,
    });

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(feedReviewFindUniqueMock).not.toHaveBeenCalled();
  });

  // -- invalid action ---------------------------------------------------

  it("rejects with 400 when action is invalid (no DB interaction)", async () => {
    mockRouteParam("req-1");
    mockReadBody.mockResolvedValue({ action: "INVALID_ACTION" });

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(feedReviewFindUniqueMock).not.toHaveBeenCalled();
    expect(feedReviewUpdateMock).not.toHaveBeenCalled();
    expect(newsSourceUpdateMock).not.toHaveBeenCalled();
    expect(sourceCategoryUpdateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  // -- request not found ------------------------------------------------

  it("rejects with 404 when review request does not exist", async () => {
    mockRouteParam("nonexistent");
    feedReviewFindUniqueMock.mockResolvedValue(null);
    mockReadBody.mockResolvedValue({ action: "RESOLVED_BY_ADMIN" });

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 404 });
  });

  // -- no provenance flags => just resolve ------------------------------

  it("resolves without provenance update when no flags are set", async () => {
    mockRouteParam("req-1");
    feedReviewFindUniqueMock.mockResolvedValue(OPEN_SOURCE_REQUEST);
    feedReviewUpdateMock.mockResolvedValue({
      id: "req-1",
      status: "RESOLVED_BY_ADMIN",
      resolvedAt: new Date(),
      resolvedByUserId: "admin-1",
    });
    mockReadBody.mockResolvedValue({ action: "RESOLVED_BY_ADMIN" });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.feedProvenanceUpdated).toBe(false);
    expect(newsSourceUpdateMock).not.toHaveBeenCalled();
    expect(sourceCategoryUpdateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
