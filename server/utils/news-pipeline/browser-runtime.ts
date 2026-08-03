/**
 * Agent 2 / Agent 3 headless browser runtime.
 *
 * Strategy for the Vercel serverless + durable-workflow runtime:
 *  - playwright-core (pinned exact version) is a STATIC import so the
 *    workflow/Nitro bundler resolves and includes it deterministically.
 *    Full `playwright` is never imported (it is not a dependency).
 *  - @sparticuz/chromium is loaded via a guarded DYNAMIC import so its
 *    package-relative binary assets (`bin/*.br`) are never inlined into the
 *    workflow bundle; if the runtime cannot provide them, the launch is
 *    classified as BROWSER_RUNTIME_UNAVAILABLE instead of resolving paths
 *    relative to the bundled entry (which previously produced the
 *    "/var/package.json" resolution failure).
 *  - CHROMIUM_EXECUTABLE_PATH env override bypasses @sparticuz/chromium
 *    entirely, so deployments with a pre-provisioned binary never search for
 *    /var/package.json.
 *  - Local/dev uses playwright-core with the system Chrome channel; when no
 *    runtime is available the result is classified — never a fake success.
 *
 * Runtime availability is classified SEPARATELY from publisher outcomes so
 * BROWSER_RUNTIME_UNAVAILABLE never becomes hard-source/publisher evidence.
 */

import { chromium } from "playwright-core";

// ─── Types ──────────────────────────────────────────────────────────────────

export type BrowserRuntimeKind =
  | "serverless-chromium"
  | "custom-executable"
  | "system-chrome"
  | "unavailable";

export type BrowserRuntimeClassification =
  | "browser_runtime_available"
  | "browser_runtime_unavailable"
  | "browser_runtime_config_invalid";

export type BrowserRuntimeSelection = {
  kind: BrowserRuntimeKind;
  classification: BrowserRuntimeClassification;
  reason: string | null;
  executablePath: string | null;
};

export type BrowserViewport = { width: number; height: number };

export type BrowserLaunchResult = {
  browser: any | null;
  classification: BrowserRuntimeClassification;
  kind: BrowserRuntimeKind;
  blockedReason: string | null;
  /** Viewport supplied by serverless Chromium, applied to each context by callers. */
  viewport?: BrowserViewport | null;
};

export type BrowserRuntimeEnv = {
  NUXT_ENABLE_AGENT2_BROWSER_FALLBACK?: string;
  CHROMIUM_EXECUTABLE_PATH?: string;
  VERCEL?: string;
  AWS_LAMBDA_FUNCTION_NAME?: string;
};

// ─── Selection (pure, testable) ─────────────────────────────────────────────

export function selectBrowserRuntime(
  env: BrowserRuntimeEnv = process.env as BrowserRuntimeEnv,
): BrowserRuntimeSelection {
  const enabled = (env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK || "").trim().toLowerCase() === "true";
  if (!enabled) {
    return {
      kind: "unavailable",
      classification: "browser_runtime_unavailable",
      reason: "browser_fallback_disabled",
      executablePath: null,
    };
  }

  const custom = (env.CHROMIUM_EXECUTABLE_PATH || "").trim();
  if (custom) {
    return {
      kind: "custom-executable",
      classification: "browser_runtime_available",
      reason: null,
      executablePath: custom,
    };
  }

  const serverless = env.VERCEL === "1" || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
  if (serverless) {
    return {
      kind: "serverless-chromium",
      classification: "browser_runtime_available",
      reason: null,
      executablePath: null,
    };
  }

  // Local/dev: playwright-core can drive an installed Chrome via channel.
  return {
    kind: "system-chrome",
    classification: "browser_runtime_available",
    reason: null,
    executablePath: null,
  };
}

// ─── Executable resolution ──────────────────────────────────────────────────

export type ServerlessChromiumImporter = () => Promise<any>;

const defaultServerlessChromiumImporter: ServerlessChromiumImporter = async () => {
  // Guarded dynamic import: @sparticuz/chromium ships binary assets that
  // cannot be inlined into the workflow bundle. If the runtime cannot provide
  // the package (e.g. the durable workflow runtime without node_modules),
  // this throws and the caller classifies the failure — it never resolves
  // paths relative to the bundled entry (/var/package.json).
  const mod = await import("@sparticuz/chromium");
  return mod?.default ?? mod;
};

let serverlessChromiumImporter: ServerlessChromiumImporter = defaultServerlessChromiumImporter;

export function setServerlessChromiumImporterForTest(
  importer: ServerlessChromiumImporter | null,
): void {
  serverlessChromiumImporter = importer ?? defaultServerlessChromiumImporter;
}

export type ExecutableResolutionResult = {
  executablePath: string | null;
  classification: BrowserRuntimeClassification;
  kind: BrowserRuntimeKind;
  reason: string | null;
};

export function describeExecutableResolutionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolveChromiumExecutable(
  selection: BrowserRuntimeSelection,
  importer: ServerlessChromiumImporter = serverlessChromiumImporter,
): Promise<ExecutableResolutionResult> {
  if (selection.kind === "custom-executable" && selection.executablePath) {
    return {
      executablePath: selection.executablePath,
      classification: "browser_runtime_available",
      kind: "custom-executable",
      reason: null,
    };
  }

  if (selection.kind === "serverless-chromium") {
    try {
      const chromiumModule = await importer();
      if (!chromiumModule?.executablePath) {
        return {
          executablePath: null,
          classification: "browser_runtime_config_invalid",
          kind: "serverless-chromium",
          reason: "serverless chromium module missing executablePath",
        };
      }
      const executablePath = await chromiumModule.executablePath();
      if (!executablePath) {
        return {
          executablePath: null,
          classification: "browser_runtime_config_invalid",
          kind: "serverless-chromium",
          reason: "serverless chromium resolved no executable path",
        };
      }
      return {
        executablePath,
        classification: "browser_runtime_available",
        kind: "serverless-chromium",
        reason: null,
      };
    } catch (error) {
      return {
        executablePath: null,
        classification: "browser_runtime_unavailable",
        kind: "serverless-chromium",
        reason: `serverless chromium: ${describeExecutableResolutionError(error)}`,
      };
    }
  }

  if (selection.kind === "system-chrome") {
    // playwright-core with the system Chrome channel — no executable path
    // lookup needed; classification happens at launch.
    return {
      executablePath: null,
      classification: "browser_runtime_available",
      kind: "system-chrome",
      reason: null,
    };
  }

  return {
    executablePath: null,
    classification: "browser_runtime_unavailable",
    kind: "unavailable",
    reason: selection.reason ?? "no browser runtime selected",
  };
}

// ─── Launch ─────────────────────────────────────────────────────────────────

export type BrowserLaunchOptions = {
  /** Timeout in ms applied to the underlying launch call. */
  launchTimeoutMs?: number;
};

export type BrowserLauncher = (
  selection: BrowserRuntimeSelection,
  executable: ExecutableResolutionResult,
  options?: BrowserLaunchOptions,
) => Promise<BrowserLaunchResult>;

const defaultLauncher: BrowserLauncher = async (selection, executable, options = {}) => {
  const launchTimeoutMs = options.launchTimeoutMs ?? 20_000;
  try {
    if (executable.kind === "serverless-chromium" && executable.executablePath) {
      const chromiumModule = await serverlessChromiumImporter();
      const browser = await chromium.launch({
        executablePath: executable.executablePath,
        args: chromiumModule?.args ?? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        headless: chromiumModule?.headless ?? true,
        timeout: launchTimeoutMs,
      });
      return {
        browser,
        classification: "browser_runtime_available",
        kind: "serverless-chromium",
        blockedReason: null,
        viewport: chromiumModule?.defaultViewport ?? { width: 1280, height: 720 },
      };
    }

    if (executable.kind === "custom-executable" && executable.executablePath) {
      const browser = await chromium.launch({
        executablePath: executable.executablePath,
        headless: true,
        timeout: launchTimeoutMs,
      });
      return {
        browser,
        classification: "browser_runtime_available",
        kind: "custom-executable",
        blockedReason: null,
        viewport: null,
      };
    }

    if (executable.kind === "system-chrome") {
      const browser = await chromium.launch({
        channel: "chrome",
        headless: true,
        timeout: launchTimeoutMs,
      });
      return {
        browser,
        classification: "browser_runtime_available",
        kind: "system-chrome",
        blockedReason: null,
        viewport: null,
      };
    }

    return {
      browser: null,
      classification: "browser_runtime_unavailable",
      kind: "unavailable",
      blockedReason: executable.reason ?? "no browser runtime selected",
      viewport: null,
    };
  } catch (error) {
    return {
      browser: null,
      classification: "browser_runtime_unavailable",
      kind: executable.kind === "system-chrome" ? "system-chrome" : executable.kind,
      blockedReason: `${executable.kind}: ${describeExecutableResolutionError(error)}`,
      viewport: null,
    };
  }
};

let launcher: BrowserLauncher = defaultLauncher;

export function setBrowserLauncherForTest(browserLauncher: BrowserLauncher | null): void {
  launcher = browserLauncher ?? defaultLauncher;
}

/**
 * Resolve the runtime and launch a headless browser.
 *
 * Returns a classified result; never throws for runtime problems. When the
 * runtime is unavailable, `classification` is "browser_runtime_unavailable"
 * and callers must treat that as a platform/runtime failure, not a publisher
 * outcome.
 */
export async function launchHeadlessBrowser(
  env: BrowserRuntimeEnv = process.env as BrowserRuntimeEnv,
  options?: BrowserLaunchOptions,
): Promise<BrowserLaunchResult> {
  const selection = selectBrowserRuntime(env);
  const executable = await resolveChromiumExecutable(selection);
  return launcher(selection, executable, options);
}

// ─── Convenience re-exports ─────────────────────────────────────────────────

/** Whether the Agent 2 browser fallback feature flag is enabled. */
export function isBrowserRuntimeFallbackEnabled(
  env: BrowserRuntimeEnv = process.env as BrowserRuntimeEnv,
): boolean {
  return selectBrowserRuntime(env).kind !== "unavailable";
}

/** Feature flag check kept for compatibility with existing callers. */
export function isAgent2BrowserFallbackEnabledFlag(
  env: BrowserRuntimeEnv = process.env as BrowserRuntimeEnv,
): boolean {
  return (env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK || "").trim().toLowerCase() === "true";
}
