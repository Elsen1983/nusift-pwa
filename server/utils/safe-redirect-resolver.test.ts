import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SAFE_REDIRECT_HOPS,
  isLikelyRedirectorUrl,
  resolveSafeRedirectChain,
} from "./safe-redirect-resolver";

// Mock DNS so tests never touch the real resolver: every hostname resolves
// to a public address, while the resolver's own IP-range checks still run.
vi.mock("node:dns/promises", () => ({
  default: {
    lookup: vi.fn(async (_hostname: string, _opts: unknown) => [
      { address: "93.184.216.34", family: 4 }, // public example A record
    ]),
  },
  lookup: vi.fn(async (_hostname: string, _opts: unknown) => [
    { address: "93.184.216.34", family: 4 },
  ]),
}));

const fetchMock = vi.fn<(...args: any[]) => Promise<Partial<Response>>>();

const makeResponse = (overrides: Partial<Response>): Partial<Response> => ({
  status: 200,
  headers: new Headers(),
  url: "",
  body: { cancel: () => Promise.resolve() } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>,
  ...overrides,
});

const redirectResponse = (location: string, status = 302): Partial<Response> =>
  makeResponse({
    status,
    headers: new Headers({ location }),
  });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveSafeRedirectChain", () => {
  it("safe public redirect resolves to the final article URL", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse("https://publisher.example.com/story/123"))
      .mockResolvedValueOnce(makeResponse({ status: 200, url: "https://publisher.example.com/story/123" }));

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalUrl).toBe("https://publisher.example.com/story/123");
      expect(result.evidence.redirectCount).toBe(1);
      expect(result.evidence.normalizedHosts).toContain("publisher.example.com");
      expect(result.evidence.httpStatus).toBe(200);
      expect(result.evidence.hops).toHaveLength(2);
    }
  });

  it("multi-hop public redirect works within the limit", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse("https://hop1.example.com/next"))
      .mockResolvedValueOnce(redirectResponse("https://hop2.example.com/final"))
      .mockResolvedValueOnce(makeResponse({ status: 200, url: "https://hop2.example.com/final" }));

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalUrl).toBe("https://hop2.example.com/final");
      expect(result.evidence.redirectCount).toBe(2);
      expect(result.evidence.normalizedHosts).toEqual(
        expect.arrayContaining(["agg.example.com", "hop1.example.com", "hop2.example.com"]),
      );
    }
  });

  it("redirect loop is rejected deterministically", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse("https://hop.example.com/b"))
      .mockResolvedValueOnce(redirectResponse("https://hop.example.com/a"))
      .mockResolvedValueOnce(redirectResponse("https://hop.example.com/b"));

    const result = await resolveSafeRedirectChain("https://hop.example.com/a");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.failureKind).toBe("invalid_redirect");
      expect(result.evidence.rejectionReason).toContain("loop");
    }
  });

  it("excessive redirects are rejected", async () => {
    for (let i = 0; i <= MAX_SAFE_REDIRECT_HOPS + 1; i++) {
      fetchMock.mockResolvedValueOnce(redirectResponse(`https://hop.example.com/${i + 1}`));
    }
    const result = await resolveSafeRedirectChain("https://hop.example.com/0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.failureKind).toBe("invalid_redirect");
      expect(result.evidence.rejectionReason).toContain("Too many redirects");
    }
  });

  it("redirect to localhost is rejected", async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse("http://localhost:8080/admin"));

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.failureKind).toBe("security_rejected");
    }
  });

  it("redirect to private IPv4 is rejected", async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse("http://10.0.0.5/secret"));

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.failureKind).toBe("security_rejected");
    }
  });

  it("redirect to link-local IPv6 is rejected", async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse("http://[fe80::1]/secret"));

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.failureKind).toBe("security_rejected");
    }
  });

  it("redirect to non-HTTP protocol is rejected", async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse("file:///etc/passwd"));

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.failureKind).toBe("security_rejected");
      expect(result.evidence.rejectionReason).toContain("protocol");
    }
  });

  it("https → http protocol downgrade is rejected", async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse("http://publisher.example.com/story"));

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.failureKind).toBe("security_rejected");
      expect(result.evidence.rejectionReason).toContain("downgrade");
    }
  });

  it("cross-host sensitive headers are not forwarded", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse("https://publisher.example.com/story"))
      .mockResolvedValueOnce(makeResponse({ status: 200, url: "https://publisher.example.com/story" }));

    await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=1");

    const secondCall = fetchMock.mock.calls[1];
    const headers = (secondCall?.[1]?.headers ?? {}) as Record<string, string>;
    const headerValues = Object.entries(headers).map(([k, v]) => `${k}:${String(v)}`).join(" ");
    expect(headerValues.toLowerCase()).not.toContain("authorization");
    expect(headerValues.toLowerCase()).not.toContain("cookie");
  });

  it("transient timeout is classified as transient_network", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    fetchMock.mockResolvedValueOnce(redirectResponse("https://publisher.example.com/story"));
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.failureKind).toBe("transient_network");
    }
  });

  it("rate limited chain is classified as rate_limited", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 429, headers: new Headers({ "retry-after": "60" }) }),
    );

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.failureKind).toBe("rate_limited");
      expect(result.evidence.httpStatus).toBe(429);
    }
  });

  it("known security rejection does not produce a final URL", async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse("http://169.254.169.254/latest/meta-data"));

    const result = await resolveSafeRedirectChain("https://agg.example.com/rd.cfm?id=1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence.finalUrl).toBeNull();
      expect(result.evidence.failureKind).toBe("security_rejected");
    }
  });
});

describe("isLikelyRedirectorUrl", () => {
  it("detects generic aggregator/redirector URL shapes", () => {
    expect(isLikelyRedirectorUrl("https://agg.example.com/rd.cfm?id=123")).toBe(true);
    expect(isLikelyRedirectorUrl("https://agg.example.com/redirect?url=https://pub.example.com/x")).toBe(true);
    expect(isLikelyRedirectorUrl("https://agg.example.com/go/out?dest=https://pub.example.com/x")).toBe(true);
    expect(isLikelyRedirectorUrl("https://agg.example.com/click?u=https://pub.example.com/x")).toBe(true);
  });

  it("does not flag ordinary article URLs", () => {
    expect(isLikelyRedirectorUrl("https://publisher.example.com/story/2026/08/02/title-here.html")).toBe(false);
    expect(isLikelyRedirectorUrl("https://publisher.example.com/news")).toBe(false);
    expect(isLikelyRedirectorUrl("https://publisher.example.com/video/player?id=5")).toBe(false);
  });

  it("ignores malformed URLs", () => {
    expect(isLikelyRedirectorUrl("not a url")).toBe(false);
    expect(isLikelyRedirectorUrl("ftp://agg.example.com/rd.cfm")).toBe(false);
  });
});
