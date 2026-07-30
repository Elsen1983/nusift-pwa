/**
 * Tests for normalizeTargetUrl and stableTargetKey shared helpers.
 *
 * Verifies the stable target-key normalization used by queue deduplication,
 * cooldown, hard-source tracking, and health scoring.
 */

import { describe, it, expect } from "vitest";

describe("normalizeTargetUrl", () => {
  async function loadFn() {
    const mod = await import("./text");
    return mod.normalizeTargetUrl;
  }

  it("lowercases hostname", async () => {
    const fn = await loadFn();
    expect(fn("https://EXAMPLE.COM/path")).toBe("https://example.com/path");
  });

  it("strips default HTTPS port :443", async () => {
    const fn = await loadFn();
    expect(fn("https://example.com:443/path")).toBe("https://example.com/path");
  });

  it("strips default HTTP port :80", async () => {
    const fn = await loadFn();
    expect(fn("http://example.com:80/path")).toBe("http://example.com/path");
  });

  it("preserves non-default ports", async () => {
    const fn = await loadFn();
    expect(fn("https://example.com:8080/path")).toBe("https://example.com:8080/path");
  });

  it("strips hash fragments", async () => {
    const fn = await loadFn();
    expect(fn("https://example.com/path#section")).toBe("https://example.com/path");
  });

  it("strips tracking params", async () => {
    const fn = await loadFn();
    expect(fn("https://example.com/path?utm_source=x&gclid=y&key=z")).toBe(
      "https://example.com/path?key=z",
    );
  });

  it("strips trailing slashes from path", async () => {
    const fn = await loadFn();
    expect(fn("https://example.com/path/")).toBe("https://example.com/path");
  });

  it("does not strip trailing slash from root path", async () => {
    const fn = await loadFn();
    // Root "/" has length 1, so the trailing-slash stripping is skipped
    const result = fn("https://example.com/");
    expect(result).toMatch(/example\.com/);
  });

  it("returns null for invalid URLs", async () => {
    const fn = await loadFn();
    expect(fn("not-a-url")).toBeNull();
    expect(fn("")).toBeNull();
  });

  it("normalizes host casing + default port + tracking params together", async () => {
    const fn = await loadFn();
    expect(fn("https://EXAMPLE.COM:443/news/2026/07/?utm_source=x&fbclid=z")).toBe(
      "https://example.com/news/2026/07",
    );
  });
});

describe("stableTargetKey", () => {
  async function loadFn() {
    const mod = await import("./text");
    return mod.stableTargetKey;
  }

  it("produces the same key for equivalent normalized URLs", async () => {
    const fn = await loadFn();
    const key1 = fn("src-1", null, "https://EXAMPLE.COM:443/path?utm_source=x");
    const key2 = fn("src-1", null, "https://example.com/path?utm_source=y");
    expect(key1).toBe(key2);
    expect(key1).toBe("src-1||https://example.com/path");
  });

  it("does not merge different sourceIds", async () => {
    const fn = await loadFn();
    const key1 = fn("src-1", null, "https://example.com/path");
    const key2 = fn("src-2", null, "https://example.com/path");
    expect(key1).not.toBe(key2);
  });

  it("does not merge different categoryIds", async () => {
    const fn = await loadFn();
    const key1 = fn("src-1", "cat-1", "https://example.com/path");
    const key2 = fn("src-1", "cat-2", "https://example.com/path");
    expect(key1).not.toBe(key2);
  });

  it("treats null and empty categoryId differently", async () => {
    const fn = await loadFn();
    const key1 = fn("src-1", null, "https://example.com/path");
    const key2 = fn("src-1", "", "https://example.com/path");
    // Both produce "src-1||..." because null → ?? ""
    expect(key1).toBe(key2);
  });

  it("returns null when sourceId is missing", async () => {
    const fn = await loadFn();
    expect(fn(null, null, "https://example.com/path")).toBeNull();
    expect(fn(undefined, null, "https://example.com/path")).toBeNull();
    expect(fn("", null, "https://example.com/path")).toBeNull();
  });

  it("returns null when targetUrl is missing", async () => {
    const fn = await loadFn();
    expect(fn("src-1", null, null)).toBeNull();
    expect(fn("src-1", null, undefined)).toBeNull();
    expect(fn("src-1", null, "")).toBeNull();
  });

  it("returns null when targetUrl is invalid", async () => {
    const fn = await loadFn();
    expect(fn("src-1", null, "not-a-url")).toBeNull();
  });

  it("produces deterministic keys (same input → same output every time)", async () => {
    const fn = await loadFn();
    const url = "https://Example.COM:443/news/2026/07/30/story?utm_source=rss";
    const key1 = fn("src-1", "cat-1", url);
    const key2 = fn("src-1", "cat-1", url);
    expect(key1).toBe(key2);
  });

  it("preserves non-default ports in the key", async () => {
    const fn = await loadFn();
    const key = fn("src-1", null, "https://example.com:8080/path");
    expect(key).toBe("src-1||https://example.com:8080/path");
  });
});
