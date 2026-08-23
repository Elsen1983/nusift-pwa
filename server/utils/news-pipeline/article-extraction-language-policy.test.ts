import { describe, expect, it } from "vitest";
import { loadJsdom } from "./jsdom-runtime";
import {
  detectArticleExtractionLanguage,
  matchesArticleBoilerplateText,
  matchesArticleBoundaryText,
} from "./article-extraction-language-policy";

describe("article extraction language policy", () => {
  it("detects the primary language from the HTML lang attribute", async () => {
    const { JSDOM } = await loadJsdom();
    const doc = new JSDOM('<html lang="hu-HU"><body></body></html>').window.document;

    expect(detectArticleExtractionLanguage(doc)).toBe("hu");
  });

  it("falls back to Open Graph locale when HTML lang is absent", async () => {
    const { JSDOM } = await loadJsdom();
    const doc = new JSDOM('<html><head><meta property="og:locale" content="hu_HU"></head></html>').window.document;

    expect(detectArticleExtractionLanguage(doc)).toBe("hu");
  });

  it("keeps English as the conservative fallback for unsupported languages", async () => {
    const { JSDOM } = await loadJsdom();
    const doc = new JSDOM('<html lang="de"><body></body></html>').window.document;

    expect(detectArticleExtractionLanguage(doc)).toBe("en");
    expect(matchesArticleBoundaryText("Related articles", detectArticleExtractionLanguage(doc))).toBe(true);
    expect(matchesArticleBoundaryText("Kapcsolódó", detectArticleExtractionLanguage(doc))).toBe(false);
  });

  it("recognizes Hungarian article-boundary headings", () => {
    for (const heading of [
      "KAPCSOLÓDÓ",
      "TOVÁBBI BELFÖLD CIKKEK",
      "Ehhez a cikkhez ajánljuk",
      "Legolvasottabb cikkek",
    ]) {
      expect(matchesArticleBoundaryText(heading, "hu"), heading).toBe(true);
    }
  });

  it("recognizes Hungarian boilerplate without matching ordinary prose", () => {
    expect(matchesArticleBoilerplateText("Kövesse az Indexet Facebookon is!", "hu")).toBe(true);
    expect(matchesArticleBoilerplateText("Tovább a termékoldalra", "hu")).toBe(true);
    expect(matchesArticleBoilerplateText("A politikus a közösségi oldalán ismertette a döntést.", "hu")).toBe(false);
  });

  it("retains English rules for Hungarian pages", () => {
    expect(matchesArticleBoundaryText("Related stories", "hu")).toBe(true);
    expect(matchesArticleBoilerplateText("Advertisement", "hu")).toBe(true);
  });
});
