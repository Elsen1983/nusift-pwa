import { describe, expect, it, vi, beforeEach } from "vitest";
import { ref, computed } from "vue";

/**
 * Tests for useI18nReady composable.
 *
 * The composable detects whether vue-i18n locale messages are loaded
 * by checking if $t(key) returns the key itself (unloaded) or real text (ready).
 */

// Mock useI18n to control translation behavior
const mockT = vi.fn();
vi.stubGlobal("useI18n", () => ({
  t: mockT,
  locale: ref("en"),
}));

describe("useI18nReady", () => {
  beforeEach(() => {
    mockT.mockReset();
  });

  async function loadComposable() {
    const mod = await import("./useI18nReady");
    return mod.useI18nReady;
  }

  it("returns isReady=false when t(key) returns the key itself", async () => {
    mockT.mockImplementation((key: string) => key);
    const useI18nReady = await loadComposable();
    const { isReady } = useI18nReady();
    expect(isReady.value).toBe(false);
  });

  it("returns isReady=true when all probe keys return real text", async () => {
    mockT.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        "auth.heading.login": "Welcome Back",
        "auth.buttons.continue_google": "Continue with Google",
        "auth.footer.terms": "Terms",
      };
      return map[key] ?? key;
    });
    const useI18nReady = await loadComposable();
    const { isReady } = useI18nReady();
    expect(isReady.value).toBe(true);
  });

  it("returns isReady=false when t(key) returns empty string", async () => {
    mockT.mockImplementation(() => "");
    const useI18nReady = await loadComposable();
    const { isReady } = useI18nReady();
    expect(isReady.value).toBe(false);
  });

  it("safeT returns translated text when i18n is ready", async () => {
    mockT.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        "auth.heading.login": "Welcome Back",
        "auth.buttons.continue_google": "Continue with Google",
      };
      return map[key] ?? key;
    });
    const useI18nReady = await loadComposable();
    const { safeT } = useI18nReady();
    expect(safeT("auth.heading.login", "Fallback")).toBe("Welcome Back");
    expect(safeT("auth.buttons.continue_google", "Fallback")).toBe("Continue with Google");
  });

  it("safeT returns fallback when i18n is not ready (key returned as-is)", async () => {
    mockT.mockImplementation((key: string) => key);
    const useI18nReady = await loadComposable();
    const { safeT } = useI18nReady();
    expect(safeT("auth.heading.login", "Welcome Back")).toBe("Welcome Back");
    expect(safeT("auth.buttons.continue_google", "Continue with Google")).toBe("Continue with Google");
  });

  it("safeT returns fallback when translation is empty", async () => {
    mockT.mockImplementation(() => "");
    const useI18nReady = await loadComposable();
    const { safeT } = useI18nReady();
    expect(safeT("auth.heading.login", "Welcome Back")).toBe("Welcome Back");
  });

  it("safeT returns fallback for unknown keys that return as-is", async () => {
    mockT.mockImplementation((key: string) => key);
    const useI18nReady = await loadComposable();
    const { safeT } = useI18nReady();
    expect(safeT("some.unknown.key", "Readable fallback")).toBe("Readable fallback");
  });
});
