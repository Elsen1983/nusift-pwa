import { describe, expect, it } from "vitest";
import { CUSTOM_PAGE_ROUTES, inferStaticFilePagePath } from "./custom-page-routes";

describe("custom page route contract", () => {
  it("uses unique names and paths", () => {
    expect(new Set(CUSTOM_PAGE_ROUTES.map((route) => route.name)).size).toBe(CUSTOM_PAGE_ROUTES.length);
    expect(new Set(CUSTOM_PAGE_ROUTES.map((route) => route.path)).size).toBe(CUSTOM_PAGE_ROUTES.length);
  });

  it("contains aliases only, not exact file-based route duplicates", () => {
    for (const route of CUSTOM_PAGE_ROUTES) {
      expect(route.path).not.toBe(inferStaticFilePagePath(route.file));
    }
  });

  it("leaves exact file-based audit and reset routes to Nuxt", () => {
    const paths = new Set<string>(CUSTOM_PAGE_ROUTES.map((route) => route.path));
    expect(paths.has("/audit/admin")).toBe(false);
    expect(paths.has("/audit/source-manager")).toBe(false);
    expect(paths.has("/reset-password")).toBe(false);
  });
});
