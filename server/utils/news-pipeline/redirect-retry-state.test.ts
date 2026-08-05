import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("../prisma", () => ({
  prisma: { pipelineArtifact: { findMany: mocks.findMany, create: mocks.create, updateMany: mocks.updateMany } },
}));

import {
  buildRedirectRetryKey,
  recordRedirectRetryState,
  sanitizeRedirectUrl,
} from "./redirect-retry-state";

describe("per-redirect retry state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "artifact-1" });
  });

  it("uses a stable normalized URL hash and redacts query values", () => {
    const first = buildRedirectRetryKey("https://example.com/redirect?token=secret&x=1");
    const second = buildRedirectRetryKey("https://example.com/redirect?token=secret&x=1");
    expect(first).toEqual(second);
    expect(first?.urlHash).toHaveLength(64);
    expect(sanitizeRedirectUrl("https://example.com/redirect?token=secret")).toContain("[redacted]");
    expect(sanitizeRedirectUrl("https://example.com/redirect?token=secret")).not.toContain("secret");
  });

  it("persists bounded retryable state for one redirect URL", async () => {
    const result = await recordRedirectRetryState({
      pipelineRunId: "run-1",
      sourceId: "source-1",
      categoryId: "category-1",
      originalUrl: "https://aggregator.example/r?id=123",
      evidence: {
        originalUrl: "https://aggregator.example/r?id=123",
        finalUrl: null,
        redirectCount: 1,
        normalizedHosts: ["aggregator.example"],
        rejectionReason: "timeout",
        httpStatus: 503,
        retryAfterMs: null,
        durationMs: 50,
        failureKind: "transient_network",
        hops: [],
      },
    });
    expect(result).toMatchObject({ sourceId: "source-1", categoryId: "category-1", failureKind: "transient_network", attemptCount: 1 });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ artifactType: "agent1_redirect_retry", status: "RETRYABLE", sourceId: "source-1", categoryId: "category-1" }),
    }));
    const payload = mocks.create.mock.calls[0]![0].data.payload;
    expect(payload.normalizedUrl).not.toContain("123");
    expect(payload.urlHash).toHaveLength(64);
  });

  it("persists a deterministic invalid redirect as a terminal artifact", async () => {
    const result = await recordRedirectRetryState({
      pipelineRunId: "run-1",
      sourceId: "source-1",
      categoryId: null,
      originalUrl: "https://aggregator.example/r?target=bad",
      evidence: {
        originalUrl: "https://aggregator.example/r?target=bad",
        finalUrl: null,
        redirectCount: 1,
        normalizedHosts: ["aggregator.example"],
        rejectionReason: "redirect loop",
        httpStatus: 302,
        retryAfterMs: null,
        durationMs: 10,
        failureKind: "invalid_redirect",
        hops: [],
      },
    });
    expect(result).toMatchObject({ status: "INVALID_REDIRECT", nextRetryAt: null });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "INVALID_REDIRECT" }),
    }));
  });

  it("does not persist security-rejected redirects as automatic retries", async () => {
    const result = await recordRedirectRetryState({
      pipelineRunId: "run-1",
      sourceId: "source-1",
      categoryId: null,
      originalUrl: "https://aggregator.example/r?target=private",
      evidence: {
        originalUrl: "https://aggregator.example/r?target=private",
        finalUrl: null,
        redirectCount: 1,
        normalizedHosts: ["aggregator.example"],
        rejectionReason: "private destination",
        httpStatus: 302,
        retryAfterMs: null,
        durationMs: 10,
        failureKind: "security_rejected",
        hops: [],
      },
    });
    expect(result).toMatchObject({ status: "SECURITY_REJECTED", nextRetryAt: null });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SECURITY_REJECTED" }),
    }));
  });

  it("returns exhausted state without a retry timestamp", async () => {
    const key = buildRedirectRetryKey("https://aggregator.example/r?id=exhausted");
    mocks.findMany.mockResolvedValue([{
      id: "artifact-exhausted",
      status: "EXHAUSTED",
      payload: {
        urlHash: key?.urlHash,
        normalizedUrl: "https://aggregator.example/r?id=[redacted]",
        failureKind: "transient_network",
        attemptCount: 5,
        nextRetryAt: new Date().toISOString(),
        lastFailureAt: new Date().toISOString(),
      },
    }]);
    const { getRedirectRetryState } = await import("./redirect-retry-state");
    const state = await getRedirectRetryState({ sourceId: "source-1", categoryId: null, url: "https://aggregator.example/r?id=exhausted" });
    expect(state).toMatchObject({ status: "EXHAUSTED", nextRetryAt: null, attemptCount: 5 });
  });
});

describe("describeRedirectStatus — terminal redirect UI semantics", () => {
  it("RETRYABLE is retryable and never terminal", async () => {
    const { describeRedirectStatus } = await import("./redirect-retry-state");
    expect(describeRedirectStatus("RETRYABLE")).toEqual({ status: "RETRYABLE", label: "retryable", terminal: false, retryable: true, resolved: false, nextRetryAt: null });
  });

  it("RESOLVED shows resolved and no retry wording", async () => {
    const { describeRedirectStatus } = await import("./redirect-retry-state");
    expect(describeRedirectStatus("RESOLVED")).toEqual({ status: "RESOLVED", label: "resolved", terminal: false, retryable: false, resolved: true, nextRetryAt: null });
  });

  it("SECURITY_REJECTED is terminal — security rejected", async () => {
    const { describeRedirectStatus } = await import("./redirect-retry-state");
    const result = describeRedirectStatus("SECURITY_REJECTED");
    expect(result.terminal).toBe(true);
    expect(result.retryable).toBe(false);
    expect(result.resolved).toBe(false);
    expect(result.nextRetryAt).toBeNull();
    expect(result.label).toContain("security rejected");
    expect(result.label).toContain("terminal");
  });

  it("INVALID_REDIRECT is terminal — invalid redirect", async () => {
    const { describeRedirectStatus } = await import("./redirect-retry-state");
    const result = describeRedirectStatus("INVALID_REDIRECT");
    expect(result.terminal).toBe(true);
    expect(result.retryable).toBe(false);
    expect(result.resolved).toBe(false);
    expect(result.nextRetryAt).toBeNull();
    expect(result.label).toContain("invalid redirect");
  });

  it("EXHAUSTED is terminal — manual reprocess only", async () => {
    const { describeRedirectStatus } = await import("./redirect-retry-state");
    const result = describeRedirectStatus("EXHAUSTED");
    expect(result.terminal).toBe(true);
    expect(result.retryable).toBe(false);
    expect(result.resolved).toBe(false);
    expect(result.nextRetryAt).toBeNull();
    expect(result.label).toContain("manual reprocess only");
  });

  it("unknown status defaults to retryable, never terminal", async () => {
    const { describeRedirectStatus } = await import("./redirect-retry-state");
    expect(describeRedirectStatus("SOMETHING_UNKNOWN")).toEqual({ status: "RETRYABLE", label: "retryable", terminal: false, retryable: true, resolved: false, nextRetryAt: null });
  });
});
