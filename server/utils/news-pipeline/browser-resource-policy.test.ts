import { describe, expect, it } from "vitest";
import {
  createResourceBlockingRouteHandler,
  shouldBlockPlaywrightRequest,
} from "./browser-resource-policy";

describe("shouldBlockPlaywrightRequest", () => {
  it("blocks image/font/media resourceTypes regardless of URL", () => {
    expect(shouldBlockPlaywrightRequest("image", "https://example.com/thing")).toBe(true);
    expect(shouldBlockPlaywrightRequest("font", "https://example.com/thing")).toBe(true);
    expect(shouldBlockPlaywrightRequest("media", "https://example.com/thing")).toBe(true);
  });

  it("never blocks document/stylesheet/xhr/fetch/script regardless of URL", () => {
    for (const resourceType of ["document", "stylesheet", "xhr", "fetch", "script"]) {
      expect(shouldBlockPlaywrightRequest(resourceType, "https://example.com/thing.png")).toBe(false);
    }
  });

  it("falls back to extension matching for ambiguous/other resourceTypes", () => {
    expect(shouldBlockPlaywrightRequest("other", "https://example.com/image.webp")).toBe(true);
    expect(shouldBlockPlaywrightRequest("other", "https://example.com/font.woff2")).toBe(true);
    expect(shouldBlockPlaywrightRequest("", "https://example.com/video.mp4?x=1")).toBe(true);
  });

  it("allows an other-typed non-heavy URL", () => {
    expect(shouldBlockPlaywrightRequest("other", "https://example.com/api/data.json")).toBe(false);
  });

  it("allows a malformed URL rather than throwing", () => {
    expect(shouldBlockPlaywrightRequest("other", "not a url")).toBe(false);
  });
});

describe("createResourceBlockingRouteHandler", () => {
  const makeRoute = (resourceType: string, url: string) => {
    let aborted = false;
    let continued = false;
    return {
      route: {
        request: () => ({ resourceType: () => resourceType, url: () => url }),
        abort: async () => { aborted = true; },
        continue: async () => { continued = true; },
      },
      wasAborted: () => aborted,
      wasContinued: () => continued,
    };
  };

  it("aborts blocked requests and continues allowed ones, tracking bounded counts", async () => {
    const { handler, getBlockedCount, getAllowedCount } = createResourceBlockingRouteHandler();

    const image = makeRoute("image", "https://example.com/a.png");
    await handler(image.route);
    expect(image.wasAborted()).toBe(true);
    expect(image.wasContinued()).toBe(false);

    const doc = makeRoute("document", "https://example.com/");
    await handler(doc.route);
    expect(doc.wasContinued()).toBe(true);
    expect(doc.wasAborted()).toBe(false);

    const script = makeRoute("script", "https://example.com/app.js");
    await handler(script.route);
    expect(script.wasContinued()).toBe(true);

    expect(getBlockedCount()).toBe(1);
    expect(getAllowedCount()).toBe(2);
  });
});
