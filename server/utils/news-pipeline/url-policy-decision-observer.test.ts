import { describe, it, expect } from "vitest";
import {
  sanitizeUrlForLogging,
  observeUrlPolicyDecisions,
  buildDecisionLogIdempotencyKey,
  getRecentUrlPolicyDecisions,
} from "./url-policy-decision-observer";
import {
  evaluateProductionUrlPolicy,
  evaluateCandidateUrlPolicy,
  CURRENT_PRODUCTION_URL_POLICY_VERSION,
  CANDIDATE_URL_POLICY_VERSION,
} from "./url-policy-evaluation";
import { classifyArticleUrl, isLikelyArticleUrl as existingIsLikelyArticleUrl } from "./article-url-policy";

// ─── Query Parameter Sanitization ──────────────────────────────────────────

describe("sanitizeUrlForLogging", () => {
  it("strips token query param", () => {
    const result = sanitizeUrlForLogging("https://example.com/article?token=abc123&id=5");
    expect(result).not.toContain("token");
    expect(result).not.toContain("abc123");
    expect(result).toContain("id=5");
  });

  it("strips api_key query param", () => {
    const result = sanitizeUrlForLogging("https://example.com/article?api_key=secret&page=2");
    expect(result).not.toContain("api_key");
    expect(result).toContain("page=2");
  });

  it("strips password query param", () => {
    const result = sanitizeUrlForLogging("https://example.com/article?password=hunter2");
    expect(result).not.toContain("password");
    expect(result).not.toContain("hunter2");
  });

  it("strips multiple sensitive params", () => {
    const result = sanitizeUrlForLogging(
      "https://example.com/article?token=abc&api_key=def&password=ghi&id=123",
    );
    expect(result).not.toContain("token");
    expect(result).not.toContain("api_key");
    expect(result).not.toContain("password");
    expect(result).toContain("id=123");
  });

  it("returns original URL unchanged when no sensitive params", () => {
    const url = "https://example.com/article?id=123&page=2";
    expect(sanitizeUrlForLogging(url)).toBe(url);
  });

  it("returns original URL when no query string", () => {
    const url = "https://example.com/article";
    expect(sanitizeUrlForLogging(url)).toBe(url);
  });

  it("returns original URL when unparseable", () => {
    const url = "not-a-url";
    expect(sanitizeUrlForLogging(url)).toBe(url);
  });
});

// ─── Decision Observation ──────────────────────────────────────────────────

describe("observeUrlPolicyDecisions", () => {
  it("returns both production and candidate decisions for a valid article URL", () => {
    const result = observeUrlPolicyDecisions({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });

    expect(result.production).toBeDefined();
    expect(result.candidate).toBeDefined();

    expect(result.production.decision).toBe("ACCEPT");
    expect(result.production.enforcementMode).toBe("ENFORCED");
    expect(result.production.policyVersion).toBe(CURRENT_PRODUCTION_URL_POLICY_VERSION);

    expect(result.candidate.decision).toBe("ACCEPT");
    expect(result.candidate.enforcementMode).toBe("SHADOW");
    expect(result.candidate.policyVersion).toBe(CANDIDATE_URL_POLICY_VERSION);
  });

  it("returns both decisions for a non-article URL", () => {
    const result = observeUrlPolicyDecisions({
      url: "https://www.rte.ie/radio/clips/11809297",
    });

    expect(result.production.decision).toBe("REJECT");
    expect(result.candidate.decision).toBe("REJECT");
  });

  it("candidate can return UNCERTAIN while production returns ACCEPT", () => {
    const result = observeUrlPolicyDecisions({
      url: "https://example.com/gallery/12345678/some-photo-album",
    });

    expect(result.production.decision).toBe("ACCEPT");
    expect(result.candidate.decision).toBe("UNCERTAIN");
  });

  it("preserves agent, stage, sourceId in both decisions", () => {
    const result = observeUrlPolicyDecisions({
      url: "https://www.bbc.com/news/articles/c1234567890o",
      sourceId: "bbc-com",
      agent: "AGENT_1",
      stage: "rss-ingest",
    });

    expect(result.production.sourceId).toBe("bbc-com");
    expect(result.candidate.sourceId).toBe("bbc-com");
    expect(result.production.agent).toBe("AGENT_1");
    expect(result.candidate.agent).toBe("AGENT_1");
    expect(result.production.stage).toBe("rss-ingest");
    expect(result.candidate.stage).toBe("rss-ingest");
  });

  it("candidate SHADOW decision never changes production decision", () => {
    const result = observeUrlPolicyDecisions({
      url: "https://www.rte.ie/radio/clips/11809297",
    });

    expect(result.production.decision).toBe("REJECT");
    expect(result.production.enforcementMode).toBe("ENFORCED");

    expect(result.candidate.decision).toBe("REJECT");
    expect(result.candidate.enforcementMode).toBe("SHADOW");
  });

  it("is side-effect-free (pure function, no I/O)", () => {
    const input = { url: "https://www.bbc.com/news/articles/c1234567890o" };
    const first = observeUrlPolicyDecisions(input);
    const second = observeUrlPolicyDecisions(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ─── Idempotency Key ───────────────────────────────────────────────────────

describe("buildDecisionLogIdempotencyKey", () => {
  it("produces stable key from decision log", () => {
    const prod = evaluateProductionUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
      agent: "AGENT_1",
      stage: "rss-ingest",
    });
    const key1 = buildDecisionLogIdempotencyKey(prod);
    const key2 = buildDecisionLogIdempotencyKey(prod);
    expect(key1).toBe(key2);
  });

  it("different URLs produce different keys", () => {
    const d1 = evaluateProductionUrlPolicy({ url: "https://example.com/a", agent: "AGENT_1", stage: "ingest" });
    const d2 = evaluateProductionUrlPolicy({ url: "https://example.com/b", agent: "AGENT_1", stage: "ingest" });
    expect(buildDecisionLogIdempotencyKey(d1)).not.toBe(buildDecisionLogIdempotencyKey(d2));
  });

  it("different enforcement modes produce different keys", () => {
    const prod = evaluateProductionUrlPolicy({ url: "https://example.com/a", agent: "AGENT_1", stage: "ingest" });
    const cand = evaluateCandidateUrlPolicy({ url: "https://example.com/a", agent: "AGENT_1", stage: "ingest" });
    expect(buildDecisionLogIdempotencyKey(prod)).not.toBe(buildDecisionLogIdempotencyKey(cand));
  });
});

// ─── Evidence is Bounded and Safe ──────────────────────────────────────────

describe("decision evidence is bounded and safe", () => {
  it("evidence contains only signals array, never full HTML or DOM", () => {
    const result = observeUrlPolicyDecisions({
      url: "https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/",
    });

    const evidence = result.production.evidence;
    expect(evidence).toBeDefined();
    expect(Array.isArray(evidence!.signals)).toBe(true);

    for (const signal of evidence!.signals as string[]) {
      expect(typeof signal).toBe("string");
      expect(signal.length).toBeLessThan(200);
    }
  });

  it("evidence does not contain keys like html, body, dom, or pageText", () => {
    const result = observeUrlPolicyDecisions({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });

    const evidence = result.production.evidence!;
    const keys = Object.keys(evidence);
    expect(keys).not.toContain("html");
    expect(keys).not.toContain("body");
    expect(keys).not.toContain("dom");
    expect(keys).not.toContain("pageText");
    expect(keys).not.toContain("fullText");
  });
});

// ─── API Output Shape ──────────────────────────────────────────────────────

describe("observation API output shape", () => {
  it("production decision preserves policyVersion, enforcementMode, reasonCode, evidence", () => {
    const dec = evaluateProductionUrlPolicy({
      url: "https://example.com/tag/politics",
      agent: "AGENT_1",
      stage: "rss-ingest",
    });

    expect(dec.policyVersion).toBe(CURRENT_PRODUCTION_URL_POLICY_VERSION);
    expect(dec.enforcementMode).toBe("ENFORCED");
    expect(dec.reasonCode).toBeTruthy();
    expect(dec.evidence).toBeDefined();
    expect(Array.isArray(dec.evidence!.signals)).toBe(true);
  });

  it("candidate decision preserves policyVersion, enforcementMode, reasonCode, evidence", () => {
    const dec = evaluateCandidateUrlPolicy({
      url: "https://example.com/gallery/12345678/some-photo-album",
      agent: "AGENT_2",
      stage: "sitemap-discovery",
    });

    expect(dec.policyVersion).toBe(CANDIDATE_URL_POLICY_VERSION);
    expect(dec.enforcementMode).toBe("SHADOW");
    expect(dec.reasonCode).toBe("low_article_url_confidence");
    expect(dec.evidence).toBeDefined();
    expect(dec.evidence!.signals).toContain("neg:gallery");
  });

  it("getRecentUrlPolicyDecisions is a bounded query function", () => {
    expect(typeof getRecentUrlPolicyDecisions).toBe("function");
  });
});

// ─── Agent 1 Integration Safety ───────────────────────────────────────────

describe("Agent 1 integration safety", () => {
  it("observeUrlPolicyDecisions does not alter classifyArticleUrl behavior", () => {
    const testUrls = [
      "https://www.bbc.com/news/articles/c1234567890o",
      "https://www.rte.ie/radio/clips/11809297",
      "https://ground.news/checkout/referral",
      "https://example.com/",
    ];

    for (const url of testUrls) {
      const before = classifyArticleUrl(url);
      observeUrlPolicyDecisions({ url });
      const after = classifyArticleUrl(url);
      expect(after.accepted).toBe(before.accepted);
      expect(after.reason).toBe(before.reason);
      expect(JSON.stringify(after.signals)).toBe(JSON.stringify(before.signals));
    }
  });

  it("SHADOW REJECT never blocks the URL", () => {
    const prod = evaluateProductionUrlPolicy({
      url: "https://www.rte.ie/radio/clips/11809297",
    });
    const cand = evaluateCandidateUrlPolicy({
      url: "https://www.rte.ie/radio/clips/11809297",
    });

    expect(prod.decision).toBe("REJECT");
    expect(prod.enforcementMode).toBe("ENFORCED");

    expect(cand.decision).toBe("REJECT");
    expect(cand.enforcementMode).toBe("SHADOW");
  });
});

// ─── Agent 2 Integration Safety ───────────────────────────────────────────

describe("Agent 2 integration safety", () => {
  it("observation does not alter isLikelyArticleUrl behavior", () => {
    const testUrls = [
      "https://www.bbc.com/news/articles/c1234567890o",
      "https://www.rte.ie/radio/clips/11809297",
      "https://example.com/tag/politics",
      "https://example.com/gallery/12345678/some-photo-album",
    ];

    for (const url of testUrls) {
      const before = existingIsLikelyArticleUrl(url);
      observeUrlPolicyDecisions({ url });
      const after = existingIsLikelyArticleUrl(url);
      expect(after).toBe(before);
    }
  });

  it("production and candidate can diverge without affecting each other", () => {
    const result = observeUrlPolicyDecisions({
      url: "https://example.com/gallery/12345678/some-photo-album",
    });

    expect(result.production.decision).toBe("ACCEPT");
    expect(result.candidate.decision).toBe("UNCERTAIN");

    expect(result.production.enforcementMode).toBe("ENFORCED");

    const independentResult = evaluateProductionUrlPolicy({
      url: "https://example.com/gallery/12345678/some-photo-album",
    });
    expect(independentResult.decision).toBe("ACCEPT");
  });
});
