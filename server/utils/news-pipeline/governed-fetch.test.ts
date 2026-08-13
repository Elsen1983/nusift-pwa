import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  governedSafeFetch,
  governedSafeFetchAndParse,
  GovernedFetchDeferredError,
  GovernedFetchRequestBudgetError,
} from "./governed-fetch";

const safeFetchMock = vi.hoisted(() => vi.fn());
const safeFetchRejectMock = vi.hoisted(() => vi.fn());
const safeFetchWithParserMock = vi.hoisted(() => vi.fn(async (url: string, options: any, parse: (response: Response) => Promise<unknown>) => {
  const first = await options.transportHooks.beforeTransport(url, true);
  const result = await safeFetchMock(url, options);
  let parseError: unknown = null;
  try {
    return await parse(result);
  } catch (error) {
    parseError = error;
    throw error;
  } finally {
    await options.transportHooks.onFinalResponse?.(url, result, first, parseError);
  }
}));
const acquireMock = vi.hoisted(() => vi.fn());
const recordMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const robotsAccessMock = vi.hoisted(() => vi.fn());

vi.mock("../ssrf-guard", () => ({
  safeFetch: safeFetchMock,
  safeFetchWithParser: safeFetchWithParserMock,
  validateHostname: vi.fn(),
}));
vi.mock("./domain-request-governor", () => ({
  parseDomainGovernorMode: (value: unknown) => value === "shadow" || value === "enforce" ? value : "off",
  acquireDomainPermit: acquireMock,
  recordDomainOutcome: recordMock,
  releaseDomainPermit: releaseMock,
}));
vi.mock("./robots-policy", () => ({
  checkPublisherRobotsAccess: robotsAccessMock,
}));

const context = (mode: "off" | "shadow" | "enforce" = "enforce", budget?: any) => ({
  agent: "agent1" as const,
  stage: "ingest",
  purpose: "feed" as const,
  mode,
  robotsPolicy: "skip" as const,
  requestBudget: budget,
});

const response = (status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(status === 429 ? { "retry-after": "60" } : {}),
  text: vi.fn(async () => "body"),
});

const permit = (allowed = true) => ({
  allowed,
  shadow: false,
  domainKey: "example.com",
  reason: allowed ? "allowed" : "circuit-open",
  leaseToken: allowed ? "lease-1" : null,
  leaseExpiresAt: allowed ? new Date(Date.now() + 30_000) : null,
  circuitState: "CLOSED",
});

describe("governed static fetch adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireMock.mockReset();
    recordMock.mockReset();
    releaseMock.mockReset();
    robotsAccessMock.mockReset();
    robotsAccessMock.mockResolvedValue({
      allowed: true,
      decision: "allowed",
      domainKey: "example.com",
      status: "no_policy",
      reason: "robots_no_policy",
      cacheHit: true,
      sitemapUrls: [],
    });
    releaseMock.mockResolvedValue({ released: true, reason: "released", domainKey: "example.com" });
  });

  it("is transparent in off mode and consumes one local slot", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    safeFetchMock.mockResolvedValue(response());
    const result = await governedSafeFetch("https://example.com/feed", {}, context("off", budget));
    expect(result.status).toBe(200);
    expect(budget.consume).toHaveBeenCalledTimes(1);
    expect(acquireMock).not.toHaveBeenCalled();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("observes but does not suppress in shadow mode", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    acquireMock.mockResolvedValue({ ...permit(), shadow: true, leaseToken: null, leaseExpiresAt: null, reason: "shadow-would-defer" });
    recordMock.mockResolvedValue({ recorded: true, reason: "recorded", domainKey: "example.com" });
    releaseMock.mockResolvedValue({ released: false, reason: "shadow-noop", domainKey: "example.com" });
    safeFetchMock.mockResolvedValue(response());
    await governedSafeFetch("https://example.com/feed", {}, context("shadow", budget));
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(budget.consume).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it("records tokenless shadow outcomes without lease mutation or suppression", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    acquireMock.mockResolvedValue({ ...permit(), shadow: true, leaseToken: null, reason: "shadow-would-allow" });
    recordMock.mockResolvedValue({ recorded: true, reason: "recorded", domainKey: "example.com" });
    safeFetchMock.mockResolvedValue(response(429));

    await governedSafeFetch("https://example.com/feed", {}, context("shadow", budget));

    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({ kind: "rate_limited", status: 429 }),
    }));
    expect(releaseMock).not.toHaveBeenCalled();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not suppress shadow transport when outcome diagnostics cannot persist", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    acquireMock.mockResolvedValue({ ...permit(), shadow: true, leaseToken: null, reason: "shadow-would-allow" });
    recordMock.mockRejectedValue(new Error("shadow db unavailable"));
    safeFetchMock.mockResolvedValue(response());

    await expect(governedSafeFetch("https://example.com/feed", {}, context("shadow", budget))).resolves.toMatchObject({ status: 200 });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses enforce-mode open circuits before transport and consumes no slot", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    acquireMock.mockResolvedValue({ ...permit(false), reason: "circuit-open", leaseToken: null });
    await expect(governedSafeFetch("https://example.com/feed", {}, context("enforce", budget)))
      .rejects.toBeInstanceOf(GovernedFetchDeferredError);
    expect(budget.consume).not.toHaveBeenCalled();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("does not acquire or transport when the local budget is empty", async () => {
    const budget = { remaining: () => 0, consume: vi.fn(() => false) };
    await expect(governedSafeFetch("https://example.com/feed", {}, context("enforce", budget)))
      .rejects.toBeInstanceOf(GovernedFetchRequestBudgetError);
    expect(acquireMock).not.toHaveBeenCalled();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("records 429 and releases the lease", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    acquireMock.mockResolvedValue(permit());
    recordMock.mockResolvedValue({ recorded: true, reason: "recorded", domainKey: "example.com" });
    releaseMock.mockResolvedValue({ released: true, reason: "released", domainKey: "example.com" });
    safeFetchMock.mockResolvedValue(response(429));
    await governedSafeFetch("https://example.com/feed", {}, context("enforce", budget));
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ kind: "rate_limited", status: 429 }) }));
    // recordDomainOutcome is the authoritative terminal operation and consumes
    // the enforce lease; no second release is attempted.
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("classifies 304 as a healthy success, never a failure (Repair 13 conditional caching)", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    acquireMock.mockResolvedValue(permit());
    recordMock.mockResolvedValue({ recorded: true, reason: "recorded", domainKey: "example.com" });
    releaseMock.mockResolvedValue({ released: true, reason: "released", domainKey: "example.com" });
    safeFetchMock.mockResolvedValue(response(304));
    await governedSafeFetch("https://example.com/sitemap.xml", {}, context("enforce", budget));
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({ kind: "success", status: 304 }),
    }));
  });

  it("preserves Retry-After from a plain case-insensitive header object", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    acquireMock.mockResolvedValue(permit());
    recordMock.mockResolvedValue({ recorded: true, reason: "recorded", domainKey: "example.com" });
    releaseMock.mockResolvedValue({ released: true, reason: "released", domainKey: "example.com" });
    safeFetchMock.mockResolvedValue({
      status: 429,
      ok: false,
      headers: { "Retry-After": "60" },
    });

    await governedSafeFetch("https://example.com/feed", {}, context("enforce", budget));

    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        kind: "rate_limited",
        status: 429,
        retryAfter: "60",
      }),
    }));
  });

  it("records the response before rethrowing a parser failure and releases the lease", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    acquireMock.mockResolvedValue(permit());
    recordMock.mockResolvedValue({ recorded: true, reason: "recorded", domainKey: "example.com" });
    releaseMock.mockResolvedValue({ released: false, reason: "token-mismatch", domainKey: "example.com" });
    safeFetchMock.mockResolvedValue(response());
    await expect(governedSafeFetchAndParse("https://example.com/feed", {}, context("enforce", budget), async () => {
      throw new Error("parse failed");
    })).rejects.toThrow("parse failed");
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("records network failure and still releases the lease", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    acquireMock.mockResolvedValue(permit());
    recordMock.mockResolvedValue({ recorded: true, reason: "recorded", domainKey: "example.com" });
    safeFetchMock.mockRejectedValue(new Error("timeout"));
    releaseMock.mockResolvedValue({ released: true, reason: "released", domainKey: "example.com" });
    safeFetchWithParserMock.mockImplementationOnce(async (url: string, options: any, _parse: (response: Response) => Promise<unknown>) => {
      const lease = await options.transportHooks.beforeTransport(url, true);
      try {
        return await safeFetchMock(url, options);
      } catch (error) {
        await options.transportHooks.onTransportError?.(url, error, lease);
        throw error;
      }
    });
    await expect(governedSafeFetch("https://example.com/feed", {}, context("enforce", budget))).rejects.toThrow("timeout");
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: "failure", status: null } }));
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("governs every redirect hop while consuming one logical budget slot", async () => {
    const budget = { remaining: () => 1, consume: vi.fn(() => true) };
    const hopUrls = [
      "https://example.com/start?secret=one",
      "https://sub.example.com/next?secret=two",
      "https://other.example.net/final?secret=three",
    ];
    acquireMock
      .mockResolvedValueOnce({ ...permit(), domainKey: "example.com", leaseToken: "lease-1" })
      .mockResolvedValueOnce({ ...permit(), domainKey: "sub.example.com", leaseToken: "lease-2" })
      .mockResolvedValueOnce({ ...permit(), domainKey: "other.example.net", leaseToken: "lease-3" });
    recordMock.mockResolvedValue({ recorded: true, reason: "recorded", domainKey: "example.com" });
    releaseMock.mockResolvedValue({ released: true, reason: "released", domainKey: "example.com" });
    safeFetchWithParserMock.mockImplementationOnce(async (_url: string, options: any, parse: (response: Response) => Promise<unknown>) => {
      const firstLease = await options.transportHooks.beforeTransport(hopUrls[0], true);
      const redirectOne = response(302);
      await options.transportHooks.onRedirectResponse(hopUrls[0], redirectOne, firstLease);
      const secondLease = await options.transportHooks.beforeTransport(hopUrls[1], false);
      await options.transportHooks.onRedirectResponse(hopUrls[1], response(301), secondLease);
      const finalLease = await options.transportHooks.beforeTransport(hopUrls[2], false);
      return options.transportHooks.onFinalResponse(hopUrls[2], response(200), finalLease, null)
        .then(() => parse(response(200) as unknown as Response));
    });

    await governedSafeFetchAndParse(hopUrls[0]!, {}, context("enforce", budget), async (finalResponse) => finalResponse.status);

    expect(acquireMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ url: hopUrls[0] }));
    expect(acquireMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ url: hopUrls[1] }));
    expect(acquireMock).toHaveBeenNthCalledWith(3, expect.objectContaining({ url: hopUrls[2] }));
    expect(budget.consume).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledTimes(3);
    // Every hop is completed by recordDomainOutcome; release is reserved for
    // paths where terminal completion did not occur.
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("checks robots before each redirect target transport", async () => {
    const redirectTarget = "https://example.com/private/article";
    safeFetchWithParserMock.mockImplementationOnce(async (url: string, options: any, parse: (response: Response) => Promise<unknown>) => {
      const first = await options.transportHooks.beforeTransport(url, true);
      const redirect = response(302);
      await options.transportHooks.onRedirectResponse(url, redirect, first);
      const second = await options.transportHooks.beforeTransport(redirectTarget, false);
      const final = response(200);
      let parseError: unknown = null;
      try {
        return await parse(final as unknown as Response);
      } catch (error) {
        parseError = error;
        throw error;
      } finally {
        await options.transportHooks.onFinalResponse?.(redirectTarget, final, second, parseError);
      }
    });

    await governedSafeFetchAndParse("https://example.com/start", {}, {
      ...context("off"),
      robotsPolicy: "required",
    }, async (finalResponse) => finalResponse.status);

    expect(robotsAccessMock).toHaveBeenCalledTimes(2);
    expect(robotsAccessMock.mock.calls.map((call: any[]) => call[0])).toEqual([
      "https://example.com/start",
      redirectTarget,
    ]);
  });
});
