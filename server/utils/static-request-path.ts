const STATIC_PREFIXES = ["/_nuxt/", "/_ipx/", "/fonts/"] as const;
const ROOT_STATIC_FILE = /^\/[^/]+\.(?:avif|css|gif|ico|jpe?g|js|mjs|png|svg|webmanifest|webp|woff2?)$/i;
const EXACT_STATIC_PATHS = new Set(["/robots.txt"]);

/**
 * Identify only known framework/public asset paths. Dots in an API or page
 * route are not sufficient evidence that the request is a static asset.
 */
export function isStaticRequestPath(pathname: string): boolean {
  if (EXACT_STATIC_PATHS.has(pathname)) return true;
  if (STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return ROOT_STATIC_FILE.test(pathname);
}
