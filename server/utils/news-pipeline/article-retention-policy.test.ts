import { describe, expect, it } from "vitest";
import {
  ARTICLE_RETENTION_DAYS,
  ARTICLE_RETENTION_MS,
  getArticleRetentionCutoff,
  isWithinArticleRetentionWindow,
  getArticleAgeReason,
} from "./article-retention-policy";

describe("article-retention-policy", () => {
  // ─── Constants ──────────────────────────────────────────────────────────

  it("ARTICLE_RETENTION_DAYS is 7", () => {
    expect(ARTICLE_RETENTION_DAYS).toBe(7);
  });

  it("ARTICLE_RETENTION_MS equals 7 days in ms", () => {
    expect(ARTICLE_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  // ─── getArticleRetentionCutoff ─────────────────────────────────────────

  describe("getArticleRetentionCutoff", () => {
    it("returns a date 7 days before now by default", () => {
      const now = new Date("2026-07-28T12:00:00Z");
      const cutoff = getArticleRetentionCutoff(now);
      expect(cutoff).toEqual(new Date("2026-07-21T12:00:00Z"));
    });

    it("respects explicit now parameter", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const cutoff = getArticleRetentionCutoff(now);
      expect(cutoff).toEqual(new Date("2025-12-25T00:00:00Z"));
    });

    it("returns a Date instance", () => {
      const cutoff = getArticleRetentionCutoff();
      expect(cutoff).toBeInstanceOf(Date);
    });
  });

  // ─── isWithinArticleRetentionWindow ────────────────────────────────────

  describe("isWithinArticleRetentionWindow", () => {
    const now = new Date("2026-07-28T12:00:00Z");

    it("returns true for an article published 1 day ago", () => {
      const publishedAt = new Date("2026-07-27T12:00:00Z");
      expect(isWithinArticleRetentionWindow(publishedAt, now)).toBe(true);
    });

    it("returns true for an article published exactly at the cutoff boundary", () => {
      const publishedAt = new Date("2026-07-21T12:00:00Z");
      expect(isWithinArticleRetentionWindow(publishedAt, now)).toBe(true);
    });

    it("returns false for an article published 8 days ago", () => {
      const publishedAt = new Date("2026-07-20T12:00:00Z");
      expect(isWithinArticleRetentionWindow(publishedAt, now)).toBe(false);
    });

    it("returns false for a future date", () => {
      const publishedAt = new Date("2026-07-29T12:00:00Z");
      expect(isWithinArticleRetentionWindow(publishedAt, now)).toBe(false);
    });

    it("returns false for null", () => {
      expect(isWithinArticleRetentionWindow(null, now)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isWithinArticleRetentionWindow(undefined, now)).toBe(false);
    });

    it("returns false for an invalid date string", () => {
      expect(isWithinArticleRetentionWindow("not-a-date", now)).toBe(false);
    });

    it("accepts ISO date strings", () => {
      expect(isWithinArticleRetentionWindow("2026-07-27T12:00:00Z", now)).toBe(true);
      expect(isWithinArticleRetentionWindow("2026-07-10T12:00:00Z", now)).toBe(false);
    });
  });

  // ─── getArticleAgeReason ──────────────────────────────────────────────

  describe("getArticleAgeReason", () => {
    const now = new Date("2026-07-28T12:00:00Z");

    it("returns null for a fresh article", () => {
      const publishedAt = new Date("2026-07-27T12:00:00Z");
      expect(getArticleAgeReason(publishedAt, now)).toBeNull();
    });

    it("returns 'outside_retention_window' for an old article", () => {
      const publishedAt = new Date("2026-07-10T12:00:00Z");
      expect(getArticleAgeReason(publishedAt, now)).toBe("outside_retention_window");
    });

    it("returns 'missing_published_at' for null", () => {
      expect(getArticleAgeReason(null, now)).toBe("missing_published_at");
    });

    it("returns 'missing_published_at' for undefined", () => {
      expect(getArticleAgeReason(undefined, now)).toBe("missing_published_at");
    });

    it("returns 'invalid_published_at' for unparseable string", () => {
      expect(getArticleAgeReason("not-a-date", now)).toBe("invalid_published_at");
    });

    it("returns 'future_published_at' for a future date", () => {
      const publishedAt = new Date("2026-07-29T12:00:00Z");
      expect(getArticleAgeReason(publishedAt, now)).toBe("future_published_at");
    });
  });

  // ─── Cross-check consistency ──────────────────────────────────────────

  describe("cross-check: retention policy consistency", () => {
    const now = new Date("2026-07-28T12:00:00Z");

    it("articles inside the window get null age reason", () => {
      const publishedAt = new Date("2026-07-25T12:00:00Z");
      expect(isWithinArticleRetentionWindow(publishedAt, now)).toBe(true);
      expect(getArticleAgeReason(publishedAt, now)).toBeNull();
    });

    it("articles outside the window get a non-null age reason", () => {
      const publishedAt = new Date("2026-07-10T12:00:00Z");
      expect(isWithinArticleRetentionWindow(publishedAt, now)).toBe(false);
      expect(getArticleAgeReason(publishedAt, now)).toBe("outside_retention_window");
    });

    it("cutoff date is the exact boundary for freshness", () => {
      const cutoff = getArticleRetentionCutoff(now);
      // At cutoff → still within window (inclusive)
      expect(isWithinArticleRetentionWindow(cutoff, now)).toBe(true);
      // 1ms before cutoff → outside window
      expect(isWithinArticleRetentionWindow(new Date(cutoff.getTime() - 1), now)).toBe(false);
    });
  });
});
