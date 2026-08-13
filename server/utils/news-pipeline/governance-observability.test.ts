import { describe, expect, it } from "vitest";
import {
  encodeGovernanceCursor,
  loadGovernanceDiagnostics,
  normalizeNetworkAttemptOutcome,
} from "./governance-observability";

const now = new Date("2026-08-10T12:00:00.000Z");

const makeDb = (domains: any[], artifacts: any[] = [], robots: any[] = []) => ({
  domainRequestGovernor: { findMany: async () => domains },
  publisherRobotsPolicy: { findMany: async () => robots },
  pipelineArtifact: { findMany: async () => artifacts },
});

describe("governance observability", () => {
  it("normalizes a browser outcome to safe bounded fields without returning URL material", () => {
    const result = normalizeNetworkAttemptOutcome({
      targetUrl: "https://example.com/private/article?id=secret",
      browserNavigation: {
        domainKey: "WWW.Example.com.",
        governorDecision: "allowed",
        mainDocumentRequests: 1,
        firstPartySubrequests: 3,
        thirdPartySubrequests: 7,
        mainDocumentStatus: 429,
        retryAfterSource: "delta_seconds",
        retryAfterAt: "2026-08-10T12:01:00.000Z",
      },
      headers: { authorization: "secret" },
      body: "article body",
    }, { persistedOutcome: "deferred", agent: "agent3", stage: "agent3", purpose: "article_detail" });

    expect(result).toMatchObject({
      domainKey: "example.com",
      transport: "browser",
      httpStatus: 429,
      leaseAcquired: true,
      firstPartySubrequests: 3,
      thirdPartySubrequests: 7,
      persistedOutcome: "deferred",
    });
    expect(JSON.stringify(result)).not.toContain("private/article");
    expect(JSON.stringify(result)).not.toContain("authorization");
    expect(JSON.stringify(result)).not.toContain("article body");
  });

  it("shows active and expired leases without exposing lease tokens", async () => {
    const result = await loadGovernanceDiagnostics(makeDb([
      { domainKey: "active.example.com", circuitState: "OPEN", cooldownUntil: new Date("2026-08-10T12:05:00Z"), nextRequestAt: null, activeLeaseToken: "secret-active-token", activeLeaseExpiresAt: new Date("2026-08-10T12:01:00Z"), lastDecision: "circuit-open", lastHttpStatus: 429, consecutive429Count: 2, consecutive403Count: 0 },
      { domainKey: "expired.example.com", circuitState: "HALF_OPEN", cooldownUntil: null, nextRequestAt: null, activeLeaseToken: "secret-expired-token", activeLeaseExpiresAt: new Date("2026-08-10T11:59:00Z"), lastDecision: "half-open-probe-granted" },
    ]), { now, limit: 10 });

    expect(result.domains.map((item) => item.lease.state)).toEqual(["active", "expired"]);
    expect(result.domains[0]?.circuitReason).toBe("circuit-open");
    expect(JSON.stringify(result)).not.toContain("secret-active-token");
    expect(JSON.stringify(result)).not.toContain("secret-expired-token");
  });

  it("surfaces a 403-driven open circuit as 'forbidden', never a paywall claim", async () => {
    const result = await loadGovernanceDiagnostics(makeDb([
      { domainKey: "blocked.example.com", circuitState: "OPEN", cooldownUntil: new Date("2026-08-10T18:00:00Z"), nextRequestAt: new Date("2026-08-10T18:00:00Z"), activeLeaseToken: null, activeLeaseExpiresAt: null, lastDecision: null, lastHttpStatus: 403, consecutive429Count: 0, consecutive403Count: 3 },
    ]), { now, limit: 10 });

    expect(result.domains[0]?.circuitReason).toBe("forbidden");
    expect(JSON.stringify(result.domains[0])).not.toMatch(/paywall/i);
  });

  it("aggregates durable stage telemetry and persisted browser evidence once", async () => {
    const result = await loadGovernanceDiagnostics(makeDb([], [
      {
        id: "stage-1", createdAt: now, artifactType: "stage_batch_telemetry", status: "CAPTURED",
        payload: { artifactKind: "stage_batch_telemetry", stage: "agent3", networkRequests: 2, browserAttempts: 1, rateLimited429: 1, rateLimited403: 0, timedOut: 1, succeeded: 1 },
      },
      {
        id: "outcome-1", createdAt: now, artifactType: "article_enrichment_rejection", status: "FAILED",
        payload: { targetUrl: "https://example.com/article?token=secret", browserNavigation: { domainKey: "example.com", governorDecision: "allowed", mainDocumentRequests: 1, firstPartySubrequests: 2, thirdPartySubrequests: 1, mainDocumentStatus: 403 } },
      },
    ]), { now, limit: 10 });

    expect(result.network.actualWork).toEqual({ networkRequests: 2, browserAttempts: 1 });
    expect(result.network.rateLimited).toEqual({ http403: 0, http429: 1 });
    expect(result.network.timedOut).toBe(1);
    expect(result.network.browserAmplification).toMatchObject({ mainDocumentRequests: 1, firstPartySubrequests: 2, thirdPartySubrequests: 1 });
    expect(result.network.outcomes).toHaveLength(1);
    expect(result.evidence.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("marks malformed legacy telemetry unavailable and reports scan truncation", async () => {
    const result = await loadGovernanceDiagnostics(makeDb([], [
      { id: "bad", createdAt: now, artifactType: "article_enrichment_result", status: "CAPTURED", payload: { body: "never expose" } },
      { id: "stage-1", createdAt: now, artifactType: "stage_batch_telemetry", status: "CAPTURED", payload: { artifactKind: "stage_batch_telemetry", stage: "agent1" } },
    ]), { now, limit: 1, scanCap: 1 });

    expect(result.evidence.truncated).toBe(true);
    expect(result.evidence.unavailableReasons).toContain("some_legacy_artifacts_lack_network_evidence");
    expect(JSON.stringify(result)).not.toContain("never expose");
  });

  it("uses deterministic opaque cursors for domain pages", () => {
    const cursor = encodeGovernanceCursor("example.com");
    expect(cursor).not.toContain("example.com");
    expect(typeof cursor).toBe("string");
  });
});
