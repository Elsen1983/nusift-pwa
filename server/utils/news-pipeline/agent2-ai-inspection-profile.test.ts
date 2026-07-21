import { describe, expect, it } from "vitest";
import {
  normalizeAgent2AiInspectionProfile,
  AI_INSPECTION_PROFILE_ARTIFACT_TYPE,
  AI_INSPECTION_PROFILE_PENDING_STATUS,
} from "./agent2-ai-inspection-profile";

const validProfile = {
  schemaVersion: 1 as const,
  targetUrl: "https://example.com/news",
  sourceId: "src-1",
  categoryId: "cat-1",
  proposedAt: "2026-07-21T10:00:00Z",
  proposedBy: "admin" as const,
  confidence: "high" as const,
  listingSelectors: ["main article-list", "section.feed"],
  articleLinkSelectors: ["a.article-card", "h2 a[href]"],
  titleSelectors: ["h1.headline", "meta[property='og:title']"],
  dateSelectors: ["time[datetime]", "meta[property='article:published_time']"],
  sampleArticleUrls: [
    "https://example.com/news/2026/07/21/story-1",
    "https://example.com/news/2026/07/20/story-2",
  ],
};

describe("normalizeAgent2AiInspectionProfile", () => {
  // ── Valid profile normalizes correctly ───────────────────────────────

  it("normalizes a valid profile with all fields", () => {
    const result = normalizeAgent2AiInspectionProfile(validProfile);
    expect(result).not.toBeNull();
    expect(result?.schemaVersion).toBe(1);
    expect(result?.targetUrl).toBe("https://example.com/news");
    expect(result?.sourceId).toBe("src-1");
    expect(result?.categoryId).toBe("cat-1");
    expect(result?.proposedAt).toBe("2026-07-21T10:00:00Z");
    expect(result?.proposedBy).toBe("admin");
    expect(result?.confidence).toBe("high");
    expect(result?.listingSelectors).toEqual(["main article-list", "section.feed"]);
    expect(result?.articleLinkSelectors).toEqual(["a.article-card", "h2 a[href]"]);
    expect(result?.titleSelectors).toEqual(["h1.headline", "meta[property='og:title']"]);
    expect(result?.dateSelectors).toEqual(["time[datetime]", "meta[property='article:published_time']"]);
    expect(result?.sampleArticleUrls).toHaveLength(2);
  });

  it("normalizes a profile with optional fields", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      descriptionSelectors: ["meta[name=description]"],
      paginationHints: ["a.next-page"],
      blockedSelectors: [".ad-container"],
      notes: ["AI proposed from screenshot review"],
    });
    expect(result).not.toBeNull();
    expect(result?.descriptionSelectors).toEqual(["meta[name=description]"]);
    expect(result?.paginationHints).toEqual(["a.next-page"]);
    expect(result?.blockedSelectors).toEqual([".ad-container"]);
    expect(result?.notes).toEqual(["AI proposed from screenshot review"]);
  });

  it("normalizes a profile proposed by ai_inspection", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      proposedBy: "ai_inspection",
    });
    expect(result?.proposedBy).toBe("ai_inspection");
  });

  it("normalizes a profile with categoryId null", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      categoryId: null,
    });
    expect(result?.categoryId).toBeNull();
  });

  it("normalizes a profile with categoryId missing (undefined)", () => {
    const { categoryId: _omit, ...withoutCategoryId } = validProfile;
    const result = normalizeAgent2AiInspectionProfile(withoutCategoryId);
    expect(result).not.toBeNull();
    expect(result?.categoryId).toBeUndefined();
  });

  // ── Malformed arrays are filtered ────────────────────────────────────

  it("filters non-string entries from selector arrays", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      listingSelectors: ["valid-selector", 42, null, "another-valid", true, undefined],
    });
    expect(result?.listingSelectors).toEqual(["valid-selector", "another-valid"]);
  });

  it("filters non-string entries from sampleArticleUrls", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      sampleArticleUrls: ["https://example.com/a", 123, null, "https://example.com/b"],
    });
    expect(result?.sampleArticleUrls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("filters non-string entries from notes", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      notes: ["valid note", 42, null, { bad: true }, "another note"],
    });
    expect(result?.notes).toEqual(["valid note", "another note"]);
  });

  it("drops empty strings from arrays", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      titleSelectors: ["", "h1", "  ", "h2"],
    });
    expect(result?.titleSelectors).toEqual(["h1", "h2"]);
  });

  it("trims whitespace from selector entries", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      listingSelectors: ["  main article-list  "],
    });
    expect(result?.listingSelectors).toEqual(["main article-list"]);
  });

  // ── Unknown / non-object input returns null ───────────────────────────

  it("returns null for null input", () => {
    expect(normalizeAgent2AiInspectionProfile(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeAgent2AiInspectionProfile(undefined)).toBeNull();
  });

  it("returns null for array input", () => {
    expect(normalizeAgent2AiInspectionProfile([1, 2, 3])).toBeNull();
  });

  it("returns null for string input", () => {
    expect(normalizeAgent2AiInspectionProfile("not an object")).toBeNull();
  });

  it("returns null for number input", () => {
    expect(normalizeAgent2AiInspectionProfile(42)).toBeNull();
  });

  it("returns null for boolean input", () => {
    expect(normalizeAgent2AiInspectionProfile(true)).toBeNull();
  });

  // ── Missing required fields return null ───────────────────────────────

  it("returns null when targetUrl is missing", () => {
    const { targetUrl: _omit, ...rest } = validProfile;
    expect(normalizeAgent2AiInspectionProfile(rest)).toBeNull();
  });

  it("returns null when sourceId is missing", () => {
    const { sourceId: _omit, ...rest } = validProfile;
    expect(normalizeAgent2AiInspectionProfile(rest)).toBeNull();
  });

  it("returns null when proposedAt is missing", () => {
    const { proposedAt: _omit, ...rest } = validProfile;
    expect(normalizeAgent2AiInspectionProfile(rest)).toBeNull();
  });

  it("returns null when proposedBy is missing", () => {
    const { proposedBy: _omit, ...rest } = validProfile;
    expect(normalizeAgent2AiInspectionProfile(rest)).toBeNull();
  });

  it("returns null when proposedBy is invalid", () => {
    expect(normalizeAgent2AiInspectionProfile({ ...validProfile, proposedBy: "system" })).toBeNull();
  });

  it("returns null when confidence is missing", () => {
    const { confidence: _omit, ...rest } = validProfile;
    expect(normalizeAgent2AiInspectionProfile(rest)).toBeNull();
  });

  it("returns null when confidence is invalid", () => {
    expect(normalizeAgent2AiInspectionProfile({ ...validProfile, confidence: "very-high" })).toBeNull();
  });

  it("returns null when schemaVersion is not 1", () => {
    expect(normalizeAgent2AiInspectionProfile({ ...validProfile, schemaVersion: 2 })).toBeNull();
  });

  it("returns null when all selector arrays are empty (no useful profile)", () => {
    expect(
      normalizeAgent2AiInspectionProfile({
        ...validProfile,
        listingSelectors: [],
        articleLinkSelectors: [],
        titleSelectors: [],
        dateSelectors: [],
      }),
    ).toBeNull();
  });

  // ── Array sizes are bounded ───────────────────────────────────────────

  it("bounds listingSelectors to 32 entries", () => {
    const manySelectors = Array.from({ length: 50 }, (_, i) => `selector-${i}`);
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      listingSelectors: manySelectors,
    });
    expect(result?.listingSelectors).toHaveLength(32);
  });

  it("bounds sampleArticleUrls to 12 entries", () => {
    const manyUrls = Array.from(
      { length: 20 },
      (_, i) => `https://example.com/news/${i}`,
    );
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      sampleArticleUrls: manyUrls,
    });
    expect(result?.sampleArticleUrls).toHaveLength(12);
  });

  it("bounds notes to 8 entries", () => {
    const manyNotes = Array.from({ length: 15 }, (_, i) => `note-${i}`);
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      notes: manyNotes,
    });
    expect(result?.notes).toHaveLength(8);
  });

  it("drops over-long selector strings (>256 chars)", () => {
    const longSelector = "a".repeat(300);
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      listingSelectors: [longSelector, "valid-short"],
    });
    expect(result?.listingSelectors).toEqual(["valid-short"]);
  });

  it("drops over-long URLs (>2048 chars)", () => {
    const longUrl = "https://example.com/" + "a".repeat(2100);
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      sampleArticleUrls: [longUrl, "https://example.com/valid"],
    });
    expect(result?.sampleArticleUrls).toEqual(["https://example.com/valid"]);
  });

  it("drops over-long notes (>512 chars)", () => {
    const longNote = "n".repeat(600);
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      notes: [longNote, "short note"],
    });
    expect(result?.notes).toEqual(["short note"]);
  });

  // ── No raw HTML / screenshot / DOM dump fields accepted ───────────────

  it("rejects profile with rawHtml field", () => {
    expect(
      normalizeAgent2AiInspectionProfile({
        ...validProfile,
        rawHtml: "<html><body>...</body></html>",
      }),
    ).toBeNull();
  });

  it("rejects profile with html field", () => {
    expect(
      normalizeAgent2AiInspectionProfile({
        ...validProfile,
        html: "<div>content</div>",
      }),
    ).toBeNull();
  });

  it("rejects profile with screenshot field", () => {
    expect(
      normalizeAgent2AiInspectionProfile({
        ...validProfile,
        screenshot: "base64encodeddata...",
      }),
    ).toBeNull();
  });

  it("rejects profile with screenshotBase64 field", () => {
    expect(
      normalizeAgent2AiInspectionProfile({
        ...validProfile,
        screenshotBase64: "iVBORw0KGgo...",
      }),
    ).toBeNull();
  });

  it("rejects profile with domDump field", () => {
    expect(
      normalizeAgent2AiInspectionProfile({
        ...validProfile,
        domDump: { body: { children: [] } },
      }),
    ).toBeNull();
  });

  it("rejects profile with outerHtml field", () => {
    expect(
      normalizeAgent2AiInspectionProfile({
        ...validProfile,
        outerHtml: "<html>...</html>",
      }),
    ).toBeNull();
  });

  it("rejects profile with pageHtml field", () => {
    expect(
      normalizeAgent2AiInspectionProfile({
        ...validProfile,
        pageHtml: "<html>...</html>",
      }),
    ).toBeNull();
  });

  it("allows null blob fields (treats as absent)", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      rawHtml: null,
      screenshot: null,
      domDump: null,
    });
    expect(result).not.toBeNull();
  });

  it("allows empty-string blob fields (treats as absent)", () => {
    const result = normalizeAgent2AiInspectionProfile({
      ...validProfile,
      rawHtml: "",
      screenshot: "",
    });
    expect(result).not.toBeNull();
  });

  // ── Constants ─────────────────────────────────────────────────────────

  it("exports the artifact type constant for future use", () => {
    expect(AI_INSPECTION_PROFILE_ARTIFACT_TYPE).toBe(
      "article_discovery_ai_inspection_profile",
    );
  });

  it("exports the pending status constant for future use", () => {
    expect(AI_INSPECTION_PROFILE_PENDING_STATUS).toBe("PENDING_REVIEW");
  });
});
