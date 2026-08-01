import { describe, expect, it } from "vitest";

import { loadJsdom } from "./jsdom-runtime";

describe("loadJsdom", () => {
  it("loads once and parses HTML in the server runtime", async () => {
    const [first, second] = await Promise.all([loadJsdom(), loadJsdom()]);
    expect(first).toBe(second);

    const dom = new first.JSDOM("<article><p>Bundled extraction content.</p></article>");
    expect(dom.window.document.querySelector("p")?.textContent).toBe("Bundled extraction content.");
    dom.window.close();
  });
});
