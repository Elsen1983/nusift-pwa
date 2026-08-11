import { describe, expect, it } from "vitest";
import { matchesDashboardSourceFilter } from "./dashboard-source-filter";

const categoryArticle = {
  sourceUrl: "https://www.corkbeo.ie/",
  sourceTargetUrl: "https://www.corkbeo.ie/news/local-news/",
  categoryPathUrl: "https://www.corkbeo.ie/news/local-news/",
};

describe("dashboard source filtering", () => {
  it("includes category-owned articles when their root source is selected", () => {
    expect(matchesDashboardSourceFilter(categoryArticle, {
      id: "corkbeo-root",
      type: "ROOT",
      url: "https://www.corkbeo.ie",
    })).toBe(true);
  });

  it("keeps category selection scoped to the exact category target", () => {
    expect(matchesDashboardSourceFilter(categoryArticle, {
      id: "corkbeo-local",
      type: "CATEGORY",
      url: "https://www.corkbeo.ie/news/local-news",
    })).toBe(true);
    expect(matchesDashboardSourceFilter(categoryArticle, {
      id: "corkbeo-sport",
      type: "CATEGORY",
      url: "https://www.corkbeo.ie/sport",
    })).toBe(false);
  });

  it("does not match articles owned by another root source", () => {
    expect(matchesDashboardSourceFilter(categoryArticle, {
      id: "other-root",
      type: "ROOT",
      url: "https://example.com",
    })).toBe(false);
  });
});
