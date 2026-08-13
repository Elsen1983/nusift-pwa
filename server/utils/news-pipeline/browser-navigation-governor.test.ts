import { beforeEach, describe, expect, it, vi } from "vitest";

const governor = vi.hoisted(() => ({
  acquire: vi.fn(),
  record: vi.fn(),
  release: vi.fn(),
}));

vi.mock("./domain-request-governor", () => ({
  parseDomainGovernorMode: (mode?: string) => mode === "shadow" || mode === "enforce" ? mode : "off",
  acquireDomainPermit: governor.acquire,
  recordDomainOutcome: governor.record,
  releaseDomainPermit: governor.release,
}));

import {
  acquireBrowserNavigationPermit,
  startGovernedBrowserNavigation,
} from "./browser-navigation-governor";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const context = {
  agent: "agent3" as const,
  stage: "test-navigation",
  mode: "enforce" as const,
  robotsPolicy: "skip" as const,
  now: () => NOW,
};

const allowedPermit = (domainKey = "example.com", leaseToken = "lease-owner") => ({
  allowed: true,
  shadow: false,
  domainKey,
  reason: "allowed",
  leaseToken,
  leaseExpiresAt: new Date(NOW.getTime() + 30_000),
  circuitState: "CLOSED",
});

const response = (
  status: number,
  url = "https://example.com/article",
  headers: Record<string, string> = {},
) => ({
  status: () => status,
  url: () => url,
  headers: () => headers,
});

const makePage = (gotoImpl: (page: any) => unknown) => {
  const handlers = new Map<string, Set<(value: any) => void>>();
  const frame = {};
  const page = {
    on: vi.fn((event: string, handler: (value: any) => void) => {
      const listeners = handlers.get(event) ?? new Set();
      listeners.add(handler);
      handlers.set(event, listeners);
    }),
    off: vi.fn((event: string, handler: (value: any) => void) => handlers.get(event)?.delete(handler)),
    removeListener: vi.fn((event: string, handler: (value: any) => void) => handlers.get(event)?.delete(handler)),
    mainFrame: () => frame,
    goto: vi.fn(() => gotoImpl(page)),
    emit: (event: string, value: any) => {
      for (const handler of handlers.get(event) ?? []) handler(value);
    },
    frame,
  };
  return page;
};

describe("browser navigation governor contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    governor.acquire.mockResolvedValue(allowedPermit());
    governor.record.mockResolvedValue({ recorded: true, domainKey: "example.com", reason: "recorded" });
    governor.release.mockResolvedValue({ released: true, domainKey: "example.com", reason: "released" });
  });

  it("denies an open circuit before browser work can be created", async () => {
    governor.acquire.mockResolvedValue({
      allowed: false,
      shadow: false,
      domainKey: "example.com",
      reason: "circuit-open",
      leaseToken: null,
      leaseExpiresAt: null,
      circuitState: "OPEN",
    });

    const permit = await acquireBrowserNavigationPermit({
      url: "https://example.com/private?token=secret",
      context,
    });

    expect(permit).toMatchObject({ allowed: false, reason: "circuit-open" });
    expect(governor.record).not.toHaveBeenCalled();
    expect(governor.release).not.toHaveBeenCalled();
  });

  it("acquires before goto and records exactly one terminal outcome", async () => {
    const order: string[] = [];
    governor.acquire.mockImplementation(async () => {
      order.push("acquire");
      return allowedPermit();
    });
    governor.record.mockImplementation(async () => {
      order.push("record");
      return { recorded: true, domainKey: "example.com", reason: "recorded" };
    });
    const page = makePage(async () => {
      order.push("goto");
      return response(200);
    });

    const navigation = await startGovernedBrowserNavigation({
      page,
      url: "https://example.com/article",
      context,
      gotoOptions: {},
    });
    expect(navigation.allowed).toBe(true);
    if (!navigation.allowed) return;
    await navigation.complete();
    await navigation.complete();

    expect(order).toEqual(["acquire", "goto", "record"]);
    expect(governor.record).toHaveBeenCalledTimes(1);
    expect(governor.release).not.toHaveBeenCalled();
  });

  it("records a navigation exception once and does not leak the lease", async () => {
    const page = makePage(async () => {
      throw new Error("navigation timeout");
    });

    const navigation = await startGovernedBrowserNavigation({
      page,
      url: "https://example.com/article",
      context,
      gotoOptions: {},
    });
    expect(navigation.allowed).toBe(true);
    if (!navigation.allowed) return;
    expect(navigation.error).toBeInstanceOf(Error);
    await navigation.complete();

    expect(governor.record).toHaveBeenCalledTimes(1);
    expect(governor.record).toHaveBeenCalledWith(expect.objectContaining({
      leaseToken: "lease-owner",
      outcome: { kind: "failure", status: null },
    }));
    expect(governor.release).not.toHaveBeenCalled();
  });

  it("uses only the acquired token when completion loses ownership", async () => {
    governor.record.mockResolvedValue({ recorded: false, domainKey: "example.com", reason: "token-mismatch" });
    governor.release.mockResolvedValue({ released: false, domainKey: "example.com", reason: "token-mismatch" });
    const page = makePage(async () => response(200));

    const navigation = await startGovernedBrowserNavigation({
      page,
      url: "https://example.com/article",
      context,
      gotoOptions: {},
    });
    expect(navigation.allowed).toBe(true);
    if (!navigation.allowed) return;
    await expect(navigation.complete()).rejects.toMatchObject({ reason: "token-mismatch" });

    expect(governor.record).toHaveBeenCalledTimes(1);
    expect(governor.release).toHaveBeenCalledTimes(1);
    expect(governor.release).toHaveBeenCalledWith(expect.objectContaining({ leaseToken: "lease-owner" }));
  });

  it("propagates main-document 429 completion conflicts and detaches listeners", async () => {
    governor.record.mockResolvedValue({ recorded: false, domainKey: "example.com", reason: "cas-conflict" });
    governor.release.mockResolvedValue({ released: false, domainKey: "example.com", reason: "token-mismatch" });
    const page = makePage(async () => response(429, "https://example.com/article", { "retry-after": "60" }));

    await expect(startGovernedBrowserNavigation({
      page,
      url: "https://example.com/article",
      context,
      gotoOptions: {},
    })).rejects.toMatchObject({ reason: "cas-conflict" });

    expect(governor.record).toHaveBeenCalledTimes(1);
    expect(governor.release).toHaveBeenCalledTimes(1);
    expect(page.off).toHaveBeenCalledWith("request", expect.any(Function));
    expect(page.off).toHaveBeenCalledWith("response", expect.any(Function));
  });

  it("opens on a main-document 429, preserves bounded Retry-After, and stops the next same-domain navigation", async () => {
    let circuitOpen = false;
    governor.acquire.mockImplementation(async () => circuitOpen
      ? { ...allowedPermit(), allowed: false, reason: "circuit-open", leaseToken: null, leaseExpiresAt: null, circuitState: "OPEN" }
      : allowedPermit());
    governor.record.mockImplementation(async (input: any) => {
      if (input.outcome.status === 429) circuitOpen = true;
      return { recorded: true, domainKey: "example.com", reason: "recorded" };
    });
    const firstPage = makePage(async () => response(429, "https://example.com/article", { "Retry-After": "120" }));

    const first = await startGovernedBrowserNavigation({
      page: firstPage,
      url: "https://example.com/article",
      context,
      gotoOptions: {},
    });
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    expect(first.evidence).toMatchObject({
      mainDocumentStatus: 429,
      authoritativePublisher429: true,
      publisherDomain429Observed: true,
      retryAfterAt: "2026-08-10T12:02:00.000Z",
      retryAfterSource: "delta_seconds",
    });
    await first.complete();

    const second = await acquireBrowserNavigationPermit({
      url: "https://example.com/other",
      context,
    });
    expect(second).toMatchObject({ allowed: false, reason: "circuit-open" });
    expect(firstPage.goto).toHaveBeenCalledTimes(1);
    expect(governor.record).toHaveBeenCalledTimes(1);
  });

  it("records main-document 403 as forbidden without rate-limit evidence", async () => {
    const page = makePage(async () => response(403));
    const navigation = await startGovernedBrowserNavigation({
      page,
      url: "https://example.com/article",
      context,
      gotoOptions: {},
    });
    expect(navigation.allowed).toBe(true);
    if (!navigation.allowed) return;
    await navigation.complete();

    expect(navigation.evidence).toMatchObject({
      mainDocumentStatus: 403,
      authoritativePublisher429: false,
      retryAfterAt: null,
      retryAfterSource: null,
    });
    expect(governor.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { kind: "forbidden", status: 403 },
    }));
  });

  it("keeps third-party 429 diagnostic-only and stores bounded secret-free counters", async () => {
    const page = makePage(async (activePage) => {
      activePage.emit("request", {
        isNavigationRequest: () => false,
        frame: () => activePage.frame,
        url: () => "https://example.com/api/content?auth=secret",
      });
      activePage.emit("request", {
        isNavigationRequest: () => false,
        frame: () => activePage.frame,
        url: () => "https://tracker.invalid/pixel?user=private",
      });
      activePage.emit("response", response(429, "https://tracker.invalid/pixel", { authorization: "secret" }));
      return response(200, "https://example.com/article?token=secret");
    });

    const navigation = await startGovernedBrowserNavigation({
      page,
      url: "https://example.com/article?token=secret",
      context,
      gotoOptions: {},
      getBlockedHeavyResources: () => 50_000,
    });
    expect(navigation.allowed).toBe(true);
    if (!navigation.allowed) return;
    await navigation.complete();

    expect(navigation.evidence).toMatchObject({
      mainDocumentRequests: 1,
      firstPartySubrequests: 1,
      thirdPartySubrequests: 1,
      blockedHeavyResources: 1_000,
      mainDocumentStatus: 200,
      publisherDomain429Observed: false,
      authoritativePublisher429: false,
    });
    expect(governor.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { kind: "success", status: 200 },
    }));
    const stored = JSON.stringify(navigation.evidence);
    expect(stored).not.toContain("/article");
    expect(stored).not.toContain("/pixel");
    expect(stored).not.toContain("secret");
    expect(stored.length).toBeLessThan(700);
  });

  it("records bounded allowedSubrequests alongside blockedHeavyResources (Repair 14)", async () => {
    const page = makePage(async () => response(200, "https://example.com/article"));

    const navigation = await startGovernedBrowserNavigation({
      page,
      url: "https://example.com/article",
      context,
      gotoOptions: {},
      getBlockedHeavyResources: () => 3,
      getAllowedSubrequests: () => 12,
    });
    expect(navigation.allowed).toBe(true);
    if (!navigation.allowed) return;
    await navigation.complete();

    expect(navigation.evidence).toMatchObject({
      blockedHeavyResources: 3,
      allowedSubrequests: 12,
    });
  });

  it("defaults allowedSubrequests to 0 when no callback is supplied", async () => {
    const page = makePage(async () => response(200, "https://example.com/article"));

    const navigation = await startGovernedBrowserNavigation({
      page,
      url: "https://example.com/article",
      context,
      gotoOptions: {},
    });
    expect(navigation.allowed).toBe(true);
    if (!navigation.allowed) return;
    await navigation.complete();

    expect(navigation.evidence.allowedSubrequests).toBe(0);
  });

  it("allows another hostname after one publisher is denied", async () => {
    governor.acquire.mockImplementation(async ({ url }: { url: string }) => {
      const host = new URL(url).hostname;
      return host === "blocked.example.com"
        ? { ...allowedPermit(host), allowed: false, reason: "circuit-open", leaseToken: null, leaseExpiresAt: null, circuitState: "OPEN" }
        : allowedPermit(host, "other-host-token");
    });

    const blocked = await acquireBrowserNavigationPermit({ url: "https://blocked.example.com/a", context });
    const other = await acquireBrowserNavigationPermit({ url: "https://other.example.com/a", context });

    expect(blocked).toMatchObject({ allowed: false, reason: "circuit-open" });
    expect(other).toMatchObject({ allowed: true });
  });
});
