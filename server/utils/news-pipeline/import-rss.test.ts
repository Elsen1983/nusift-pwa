import { describe, expect, it } from "vitest";
import { buildFeedUrlCandidates } from "./import-rss";

describe("buildFeedUrlCandidates", () => {
  it("adds bounded working RTE root-feed recoveries after the configured feed", () => {
    expect(buildFeedUrlCandidates("https://rte.ie/?service=rss", "https://rte.ie")).toEqual([
      "https://rte.ie/?service=rss",
      "https://www.rte.ie/feeds/rss/?index=/news/",
      "https://www.rte.ie/feeds/rss/?index=/news/world/",
    ]);
  });

  it("does not add RTE-specific feeds for other publishers", () => {
    expect(buildFeedUrlCandidates(null, "https://example.test")).toEqual([
      "https://example.test/?service=rss",
    ]);
  });
});
