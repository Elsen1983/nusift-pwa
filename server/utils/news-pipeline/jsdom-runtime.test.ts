import { describe, expect, it } from "vitest";
import { loadJsdom } from "./jsdom-runtime";

describe("serverless DOM runtime", () => {
  it("provides the extraction DOM surface without package-adjacent assets", async () => {
    const { JSDOM } = await loadJsdom();
    const dom = new JSDOM("<html><head></head><body><article><p>News body</p></article></body></html>", {
      url: "https://example.com/news/story",
    });

    expect(dom.window.document.querySelector("article p")?.textContent).toBe("News body");
    expect(dom.window.document.querySelector("base")?.getAttribute("href"))
      .toBe("https://example.com/news/story");
    expect(() => dom.window.close()).not.toThrow();
  });
});
