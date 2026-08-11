import { describe, expect, it } from "vitest";
import { isStaticRequestPath } from "./static-request-path";

describe("isStaticRequestPath", () => {
  it.each([
    "/_nuxt/app.js",
    "/_ipx/w_200/avatar.png",
    "/fonts/rajdhani.woff2",
    "/favicon.ico",
    "/pwa-192x192.png",
    "/sw.js",
    "/robots.txt",
  ])("accepts known static path %s", (path) => {
    expect(isStaticRequestPath(path)).toBe(true);
  });

  it.each([
    "/api/report.v2",
    "/api/export.json",
    "/audit/source.example",
    "/dashboard/dashboard-main",
  ])("does not classify dotted application route %s as static", (path) => {
    expect(isStaticRequestPath(path)).toBe(false);
  });
});
