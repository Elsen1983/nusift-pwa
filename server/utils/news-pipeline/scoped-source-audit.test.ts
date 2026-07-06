import { describe, expect, it } from "vitest";
import { buildScopedSourceAuditReport } from "./scoped-source-audit";

describe("buildScopedSourceAuditReport", () => {
  it("marks legacy independent.ie regionals sources for deletion when they reuse the root feed", () => {
    const report = buildScopedSourceAuditReport([
      {
        id: "root",
        frontPageUrl: "https://www.independent.ie/",
        mediaName: "Irish Independent",
        rssFeedUrl: "https://www.independent.ie/rss",
        rssStatus: "ACTIVE",
      },
      {
        id: "child",
        frontPageUrl: "http://www.independent.ie/regionals/wexfordpeople",
        mediaName: "Wexford People",
        rssFeedUrl: "https://www.independent.ie/rss",
        rssStatus: "ACTIVE",
      },
    ]);

    expect(report.summary.candidateDeleteInvalidSubpath).toBe(1);
    expect(report.items[0]?.action).toBe("candidate_delete_invalid_subpath");
  });

  it("marks plain http sub-path sources for normalization when no stronger signal exists", () => {
    const report = buildScopedSourceAuditReport([
      {
        id: "child",
        frontPageUrl: "http://example.com/news/local",
        mediaName: "Example Local",
        rssFeedUrl: "https://example.com/news/local/rss",
        rssStatus: "ACTIVE",
      },
    ]);

    expect(report.summary.normalizeToHttps).toBe(1);
    expect(report.items[0]?.normalizedFrontPageUrl).toBe("https://example.com/news/local/");
  });
});
