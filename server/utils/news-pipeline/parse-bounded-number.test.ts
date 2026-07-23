import { describe, expect, it } from "vitest";
import { readBoundedNumber } from "./parse-bounded-number";

describe("readBoundedNumber", () => {
  // ── Missing / empty / nullish ──────────────────────────────────────────

  it("returns fallback for undefined", () => {
    expect(readBoundedNumber(undefined, 5, 1, 50)).toBe(5);
  });

  it("returns fallback for null", () => {
    expect(readBoundedNumber(null, 5, 1, 50)).toBe(5);
  });

  it("returns fallback for empty string", () => {
    expect(readBoundedNumber("", 5, 1, 50)).toBe(5);
  });

  it("returns fallback for whitespace-only string", () => {
    expect(readBoundedNumber("   ", 5, 1, 50)).toBe(5);
  });

  // ── Booleans ───────────────────────────────────────────────────────────

  it("returns fallback for true", () => {
    expect(readBoundedNumber(true, 5, 1, 50)).toBe(5);
  });

  it("returns fallback for false", () => {
    expect(readBoundedNumber(false, 5, 1, 50)).toBe(5);
  });

  // ── Non-numeric / non-finite ───────────────────────────────────────────

  it("returns fallback for non-numeric string", () => {
    expect(readBoundedNumber("abc", 5, 1, 50)).toBe(5);
  });

  it("returns fallback for NaN", () => {
    expect(readBoundedNumber(NaN, 5, 1, 50)).toBe(5);
  });

  it("returns fallback for Infinity", () => {
    expect(readBoundedNumber(Infinity, 5, 1, 50)).toBe(5);
  });

  it("returns fallback for -Infinity", () => {
    expect(readBoundedNumber(-Infinity, 5, 1, 50)).toBe(5);
  });

  // ── Valid numeric values ───────────────────────────────────────────────

  it("parses valid numeric string", () => {
    expect(readBoundedNumber("10", 5, 1, 50)).toBe(10);
  });

  it("floors fractional values", () => {
    expect(readBoundedNumber(3.7, 5, 1, 50)).toBe(3);
  });

  it("floors fractional string values", () => {
    expect(readBoundedNumber("3.9", 5, 1, 50)).toBe(3);
  });

  it("clamps to min", () => {
    expect(readBoundedNumber(0, 5, 1, 50)).toBe(1);
  });

  it("clamps negative to min", () => {
    expect(readBoundedNumber(-3, 5, 1, 50)).toBe(1);
  });

  it("clamps to max", () => {
    expect(readBoundedNumber(999, 5, 1, 50)).toBe(50);
  });

  it("passes through valid value in range", () => {
    expect(readBoundedNumber(25, 5, 1, 50)).toBe(25);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("handles negative numeric string by clamping", () => {
    expect(readBoundedNumber("-5", 5, 1, 50)).toBe(1);
  });

  it("handles numeric string with leading/trailing spaces", () => {
    // Number(" 10 ") = 10, which is finite
    expect(readBoundedNumber(" 10 ", 5, 1, 50)).toBe(10);
  });
});
