/**
 * Shared `resourceType()`-aware Playwright request-blocking policy
 * (Repair 14). One authority used by every browser call site instead of
 * three duplicated extension-glob route registrations.
 *
 * Playwright cannot combine a URL glob with a resourceType check on the same
 * `page.route()` call, so callers must register a catch-all route
 * (`page.route("**\/*", handler)`) and let this module's handler decide.
 */

/** Resource classes that are always safe to drop for article rendering. */
const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "media"]);

/**
 * Never blocked, regardless of URL — the main document, required
 * stylesheets, and first-party API/script calls a publisher's rendering may
 * depend on (Repair 14 requirements 7-8).
 */
const NEVER_BLOCK_RESOURCE_TYPES = new Set(["document", "stylesheet", "xhr", "fetch", "script"]);

/**
 * Fallback for ambiguous/untyped ("other") requests: the same heavy-file
 * extension set the three call sites already used, extended slightly for
 * consistency across them.
 */
const HEAVY_EXTENSION_RE =
  /\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|mp4|mp3|wav|ogg|webm|mov|avi|woff2?|ttf|eot|otf)(?:[?#]|$)/i;

/** Pure classification — no Playwright objects, fully unit-testable. */
export function shouldBlockPlaywrightRequest(resourceType: string, url: string): boolean {
  if (NEVER_BLOCK_RESOURCE_TYPES.has(resourceType)) return false;
  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) return true;
  try {
    return HEAVY_EXTENSION_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export type ResourceBlockingRouteHandler = {
  handler: (route: any) => Promise<void>;
  getBlockedCount: () => number;
  getAllowedCount: () => number;
};

/**
 * One `page.route("**\/*", handler)` registration per navigation. Bounded,
 * redacted counters (no URLs/queries/headers ever recorded) feed the
 * existing browser-navigation-governor evidence via
 * getBlockedHeavyResources/getAllowedSubrequests.
 */
export function createResourceBlockingRouteHandler(): ResourceBlockingRouteHandler {
  let blocked = 0;
  let allowed = 0;
  const handler = async (route: any) => {
    const request = typeof route?.request === "function" ? route.request() : null;
    const resourceType = typeof request?.resourceType === "function" ? request.resourceType() : "";
    const url = typeof request?.url === "function" ? request.url() : "";
    if (shouldBlockPlaywrightRequest(resourceType, url)) {
      blocked += 1;
      await route.abort();
      return;
    }
    allowed += 1;
    await route.continue();
  };
  return {
    handler,
    getBlockedCount: () => blocked,
    getAllowedCount: () => allowed,
  };
}
