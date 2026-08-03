import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveChromiumExecutable,
  selectBrowserRuntime,
  launchHeadlessBrowser,
  setBrowserLauncherForTest,
  setServerlessChromiumImporterForTest,
  isBrowserRuntimeFallbackEnabled,
  isAgent2BrowserFallbackEnabledFlag,
  type BrowserLaunchResult,
  type BrowserRuntimeSelection,
  type ExecutableResolutionResult,
} from "./browser-runtime";

// playwright-core is statically imported by browser-runtime; vitest resolves
// it from node_modules. All launch behavior is exercised through the launcher
// hook below, so no real browser is ever started in these tests.

describe("selectBrowserRuntime", () => {
  it("is unavailable when the fallback flag is not enabled", () => {
    const selection = selectBrowserRuntime({});
    expect(selection).toMatchObject({
      kind: "unavailable",
      classification: "browser_runtime_unavailable",
      reason: "browser_fallback_disabled",
    });
  });

  it("prefers the custom executable override on any platform", () => {
    const selection = selectBrowserRuntime({
      NUXT_ENABLE_AGENT2_BROWSER_FALLBACK: "true",
      CHROMIUM_EXECUTABLE_PATH: "/opt/chromium/chrome",
      VERCEL: "1",
    });
    expect(selection).toMatchObject({
      kind: "custom-executable",
      classification: "browser_runtime_available",
      executablePath: "/opt/chromium/chrome",
    });
  });

  it("selects serverless chromium on Vercel/Lambda", () => {
    expect(selectBrowserRuntime({ NUXT_ENABLE_AGENT2_BROWSER_FALLBACK: "true", VERCEL: "1" }).kind)
      .toBe("serverless-chromium");
    expect(selectBrowserRuntime({
      NUXT_ENABLE_AGENT2_BROWSER_FALLBACK: "true",
      AWS_LAMBDA_FUNCTION_NAME: "nusift",
    }).kind).toBe("serverless-chromium");
  });

  it("selects system chrome locally when the flag is enabled", () => {
    const selection = selectBrowserRuntime({ NUXT_ENABLE_AGENT2_BROWSER_FALLBACK: "true" });
    expect(selection.kind).toBe("system-chrome");
  });
});

describe("resolveChromiumExecutable", () => {
  const serverless = {
    kind: "serverless-chromium",
    classification: "browser_runtime_available",
    reason: null,
    executablePath: null,
  } as BrowserRuntimeSelection;

  it("resolves the custom executable path directly", async () => {
    const result = await resolveChromiumExecutable({
      kind: "custom-executable",
      classification: "browser_runtime_available",
      reason: null,
      executablePath: "/opt/chrome",
    });
    expect(result).toMatchObject({
      executablePath: "/opt/chrome",
      classification: "browser_runtime_available",
      kind: "custom-executable",
    });
  });

  it("resolves the serverless chromium executable through the module", async () => {
    setServerlessChromiumImporterForTest(async () => ({
      executablePath: async () => "/tmp/chromium",
    }));
    const result = await resolveChromiumExecutable(serverless);
    expect(result).toMatchObject({
      executablePath: "/tmp/chromium",
      classification: "browser_runtime_available",
      kind: "serverless-chromium",
      reason: null,
    });
  });

  it("classifies a missing serverless chromium module as config invalid", async () => {
    setServerlessChromiumImporterForTest(async () => ({}) as any);
    const result = await resolveChromiumExecutable(serverless);
    expect(result.classification).toBe("browser_runtime_config_invalid");
  });

  it("classifies an import failure as browser runtime unavailable (no /var/package.json path used)", async () => {
    setServerlessChromiumImporterForTest(async () => {
      throw new Error("Cannot find module '/var/package.json'");
    });
    const result = await resolveChromiumExecutable(serverless);
    expect(result.classification).toBe("browser_runtime_unavailable");
    expect(result.reason).toContain("serverless chromium");
    expect(result.reason).toContain("/var/package.json"); // surfaced for diagnosis, never used as a path
    expect(result.executablePath).toBeNull();
  });

  it("returns unavailable for a disabled selection", async () => {
    const result = await resolveChromiumExecutable({
      kind: "unavailable",
      classification: "browser_runtime_unavailable",
      reason: "browser_fallback_disabled",
      executablePath: null,
    });
    expect(result.classification).toBe("browser_runtime_unavailable");
  });
});

describe("launchHeadlessBrowser", () => {
  beforeEach(() => {
    setBrowserLauncherForTest(null);
    setServerlessChromiumImporterForTest(null);
  });

  afterEach(() => {
    setBrowserLauncherForTest(null);
    setServerlessChromiumImporterForTest(null);
  });

  it("classifies a disabled runtime without launching anything", async () => {
    const launcherSpy = vi.fn(async (): Promise<BrowserLaunchResult> => ({
      browser: null,
      classification: "browser_runtime_unavailable",
      kind: "unavailable",
      blockedReason: "no browser runtime selected",
    }));
    setBrowserLauncherForTest(launcherSpy as any);

    const result = await launchHeadlessBrowser({} as any);
    expect(result.classification).toBe("browser_runtime_unavailable");
    expect(result.kind).toBe("unavailable");
  });

  it("launches through a mockable adapter and reports availability", async () => {
    const mockBrowser = { newContext: vi.fn(), close: vi.fn() };
    setBrowserLauncherForTest(async (_selection, executable) => ({
      browser: mockBrowser,
      classification: "browser_runtime_available",
      kind: executable.kind,
      blockedReason: null,
    }));

    const result = await launchHeadlessBrowser({
      NUXT_ENABLE_AGENT2_BROWSER_FALLBACK: "true",
      CHROMIUM_EXECUTABLE_PATH: "/opt/chrome",
    } as any);
    expect(result).toMatchObject({
      browser: mockBrowser,
      classification: "browser_runtime_available",
      kind: "custom-executable",
      blockedReason: null,
    });
  });

  it("never fabricates success when the adapter cannot launch", async () => {
    setBrowserLauncherForTest(async (_selection, executable) => ({
      browser: null,
      classification: "browser_runtime_unavailable",
      kind: executable.kind,
      blockedReason: `${executable.kind}: launch failed`,
    }));

    const result = await launchHeadlessBrowser({
      NUXT_ENABLE_AGENT2_BROWSER_FALLBACK: "true",
      VERCEL: "1",
    } as any);
    expect(result.browser).toBeNull();
    expect(result.classification).toBe("browser_runtime_unavailable");
    expect(result.blockedReason).toContain("serverless-chromium");
  });
});

describe("feature flags", () => {
  it("isBrowserFallbackEnabled matches the flag semantics", () => {
    expect(isBrowserRuntimeFallbackEnabled({} as any)).toBe(false);
    expect(isBrowserRuntimeFallbackEnabled({ NUXT_ENABLE_AGENT2_BROWSER_FALLBACK: "true" } as any)).toBe(true);
    expect(isAgent2BrowserFallbackEnabledFlag({ NUXT_ENABLE_AGENT2_BROWSER_FALLBACK: "TRUE" } as any)).toBe(true);
    expect(isAgent2BrowserFallbackEnabledFlag({} as any)).toBe(false);
  });
});

