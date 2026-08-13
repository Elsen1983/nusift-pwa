import { describe, expect, it } from "vitest";
import {
  collectMatchingObjects,
  extractItemListEntries,
  extractNextDataCandidates,
  extractStructuredScriptBlocks,
  getJsonLdTypes,
  normalizeJsonLdType,
  parseBoundedJson,
  STRUCTURED_DATA_MAX_ARRAY_LENGTH_SCANNED,
  STRUCTURED_DATA_MAX_OBJECTS_VISITED,
  STRUCTURED_DATA_MAX_SCRIPT_CHARS,
  STRUCTURED_DATA_MAX_SCRIPTS_PER_PAGE,
} from "./structured-data";

describe("normalizeJsonLdType / getJsonLdTypes", () => {
  it("strips namespace prefixes and reads array @type", () => {
    expect(normalizeJsonLdType("schema:NewsArticle")).toBe("NewsArticle");
    expect(normalizeJsonLdType(["Article", "schema:CreativeWork"])).toBe("Article");
    expect(getJsonLdTypes(["ItemList", "schema:BreadcrumbList"])).toEqual(["ItemList", "BreadcrumbList"]);
    expect(getJsonLdTypes(undefined)).toEqual([]);
  });
});

describe("extractStructuredScriptBlocks", () => {
  it("extracts ld+json blocks and, when requested, the __NEXT_DATA__ block", () => {
    const html = `
      <script type="application/ld+json">{"@type":"Article"}</script>
      <script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>`;
    const blocks = extractStructuredScriptBlocks(html, { includeNextData: true });
    expect(blocks.map((b) => b.kind)).toEqual(["ld+json", "next-data"]);
  });

  it("omits __NEXT_DATA__ when not requested", () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>`;
    expect(extractStructuredScriptBlocks(html)).toEqual([]);
  });

  it("caps the number of ld+json scripts scanned per page", () => {
    const html = Array.from({ length: STRUCTURED_DATA_MAX_SCRIPTS_PER_PAGE + 10 }, (_, i) =>
      `<script type="application/ld+json">{"@type":"Article","n":${i}}</script>`).join("\n");
    const blocks = extractStructuredScriptBlocks(html);
    expect(blocks.length).toBe(STRUCTURED_DATA_MAX_SCRIPTS_PER_PAGE);
  });

  it("caps each block to the bounded character length", () => {
    const oversized = `{"@type":"Article","x":"${"a".repeat(STRUCTURED_DATA_MAX_SCRIPT_CHARS + 1000)}"}`;
    const html = `<script type="application/ld+json">${oversized}</script>`;
    const blocks = extractStructuredScriptBlocks(html);
    expect(blocks[0]?.text.length).toBe(STRUCTURED_DATA_MAX_SCRIPT_CHARS);
  });
});

describe("parseBoundedJson", () => {
  it("parses valid JSON", () => {
    expect(parseBoundedJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for malformed JSON", () => {
    expect(parseBoundedJson("{ not json")).toBeNull();
  });

  it("returns null for text exceeding the bounded length", () => {
    expect(parseBoundedJson("a".repeat(STRUCTURED_DATA_MAX_SCRIPT_CHARS + 1))).toBeNull();
  });
});

describe("collectMatchingObjects", () => {
  const isArticle = (r: Record<string, unknown>) => r["@type"] === "Article";

  it("finds matches nested inside @graph arrays at any depth", () => {
    const value = { "@graph": [{ "@type": "WebSite" }, { "@graph": [{ "@type": "Article", id: "deep" }] }] };
    const found = collectMatchingObjects(value, isArticle);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("deep");
  });

  it("stops boundedly on deeply nested structures beyond the depth cap", () => {
    let deep: unknown = { "@type": "Article", marker: true };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    const found = collectMatchingObjects(deep, isArticle);
    expect(found).toHaveLength(0); // the Article object is beyond maxDepth
  });

  it("finds a match within the depth cap", () => {
    let shallow: unknown = { "@type": "Article", marker: true };
    for (let i = 0; i < 3; i += 1) shallow = { nested: shallow };
    const found = collectMatchingObjects(shallow, isArticle);
    expect(found).toHaveLength(1);
  });

  it("caps the number of array elements scanned per level", () => {
    const arr = Array.from({ length: STRUCTURED_DATA_MAX_ARRAY_LENGTH_SCANNED + 50 }, (_, i) => ({
      "@type": "Article",
      n: i,
    }));
    const found = collectMatchingObjects(arr, isArticle);
    expect(found).toHaveLength(STRUCTURED_DATA_MAX_ARRAY_LENGTH_SCANNED);
  });

  it("caps the total number of objects visited", () => {
    const arr = Array.from({ length: STRUCTURED_DATA_MAX_OBJECTS_VISITED + 500 }, () => ({ "@type": "Other" }));
    const found = collectMatchingObjects(arr, () => true, { maxArrayLength: STRUCTURED_DATA_MAX_OBJECTS_VISITED + 500 });
    expect(found.length).toBeLessThanOrEqual(STRUCTURED_DATA_MAX_OBJECTS_VISITED);
  });

  it("stops boundedly on a hand-built cyclic object instead of hanging", () => {
    const cyclic: Record<string, unknown> = { "@type": "Article", marker: true };
    cyclic.self = cyclic;
    const found = collectMatchingObjects(cyclic, isArticle);
    expect(found).toHaveLength(1);
  });
});

describe("extractItemListEntries", () => {
  it("extracts article URLs from a valid ItemList", () => {
    const root = {
      "@type": "ItemList",
      itemListElement: [
        { "@type": "ListItem", position: 1, item: { url: "/a", name: "First" } },
        { "@type": "ListItem", position: 2, url: "/b", name: "Second" },
      ],
    };
    const entries = extractItemListEntries(root);
    expect(entries.map((e) => e.url)).toEqual(["/a", "/b"]);
    expect(entries[0]?.name).toBe("First");
  });

  it("rejects BreadcrumbList entirely", () => {
    const root = {
      "@type": "BreadcrumbList",
      itemListElement: [{ "@type": "ListItem", position: 1, item: { url: "/category" } }],
    };
    expect(extractItemListEntries(root)).toEqual([]);
  });

  it("rejects entries whose nested item is a known non-article type", () => {
    const root = {
      "@type": "ItemList",
      itemListElement: [
        { "@type": "ListItem", item: { "@type": "Product", url: "/shop/widget" } },
        { "@type": "ListItem", item: { "@type": "Person", url: "/author/jane" } },
        { "@type": "ListItem", item: { url: "/news/real-article" } },
      ],
    };
    const entries = extractItemListEntries(root);
    expect(entries.map((e) => e.url)).toEqual(["/news/real-article"]);
  });

  it("returns no entries for a malformed/empty ItemList", () => {
    expect(extractItemListEntries({ "@type": "ItemList" })).toEqual([]);
    expect(extractItemListEntries(null)).toEqual([]);
  });
});

describe("extractNextDataCandidates", () => {
  const pageUrl = "https://example.com/news";

  it("accepts entries with a URL and a title", () => {
    const script = JSON.stringify({
      props: { pageProps: { articles: [{ url: "/a", title: "Headline A" }, { slug: "/b", headline: "Headline B" }] } },
    });
    const candidates = extractNextDataCandidates(script, pageUrl);
    expect(candidates.map((c) => c.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("accepts entries with a URL and a date but no title", () => {
    const script = JSON.stringify({
      props: { pageProps: { posts: [{ href: "/c", publishedAt: "2026-08-01" }] } },
    });
    const candidates = extractNextDataCandidates(script, pageUrl);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.date).toBe("2026-08-01");
  });

  it("rejects entries with a URL but no title/date evidence", () => {
    const script = JSON.stringify({ props: { pageProps: { items: [{ url: "/d" }] } } });
    expect(extractNextDataCandidates(script, pageUrl)).toEqual([]);
  });

  it("finds article arrays nested deeper under pageProps", () => {
    const script = JSON.stringify({
      props: { pageProps: { data: { initialState: { feed: { articles: [{ url: "/e", title: "Nested" }] } } } } },
    });
    const candidates = extractNextDataCandidates(script, pageUrl);
    expect(candidates.map((c) => c.url)).toEqual(["https://example.com/e"]);
  });

  it("returns no candidates for malformed or missing pageProps", () => {
    expect(extractNextDataCandidates("{ not json", pageUrl)).toEqual([]);
    expect(extractNextDataCandidates(JSON.stringify({ props: {} }), pageUrl)).toEqual([]);
    expect(extractNextDataCandidates(JSON.stringify({}), pageUrl)).toEqual([]);
  });

  it("stops boundedly on an oversized script", () => {
    const script = "a".repeat(STRUCTURED_DATA_MAX_SCRIPT_CHARS + 1);
    expect(extractNextDataCandidates(script, pageUrl)).toEqual([]);
  });
});
