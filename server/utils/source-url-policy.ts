/**
 * Reject only URLs with strong individual-article evidence. Nested section
 * paths are valid source targets and cannot be classified by depth alone.
 */
export function isLikelyIndividualArticleUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!path) return false;

    const segments = path.split("/").filter(Boolean);
    if (/\/(?:19|20)\d{2}\/[01]\d\/[0-3]\d(?:\/|$)/.test(url.pathname)) {
      return true;
    }

    if (segments.some((segment) => /\d{6,}/.test(segment))) {
      return true;
    }

    const lastSegment = segments.at(-1) || "";
    const hyphenCount = (lastSegment.match(/-/g) || []).length;
    return lastSegment.length > 40 || hyphenCount > 4;
  } catch {
    return false;
  }
}
