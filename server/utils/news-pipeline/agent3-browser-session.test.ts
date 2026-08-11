import { describe, expect, it, vi } from "vitest";
import {
  Agent3BrowserSessionError,
  createAgent3BrowserSession,
} from "./agent3-browser-session";

function makeBrowserFixture() {
  const pages: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const contexts: Array<{ newPage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const browser = {
    newContext: vi.fn(async () => {
      const context = {
        newPage: vi.fn(async () => {
          const page = { close: vi.fn(async () => {}) };
          pages.push(page);
          return page;
        }),
        close: vi.fn(async () => {}),
      };
      contexts.push(context);
      return context;
    }),
    close: vi.fn(async () => {}),
  };
  return { browser, contexts, pages };
}

describe("Agent3BrowserSession", () => {
  it("launches once, reuses a same-domain context, and gives each article a fresh page", async () => {
    const fixture = makeBrowserFixture();
    const launch = vi.fn(async () => ({ browser: fixture.browser, viewport: null }));
    const session = createAgent3BrowserSession({ launch, maxNavigationsPerContext: 3 });

    const first = await session.openPage("https://www.example.com/a");
    await first.close();
    const second = await session.openPage("https://example.com/b");
    await second.close();
    await session.close();

    expect(launch).toHaveBeenCalledTimes(1);
    expect(fixture.browser.newContext).toHaveBeenCalledTimes(1);
    expect(fixture.contexts[0]?.newPage).toHaveBeenCalledTimes(2);
    expect(fixture.pages).toHaveLength(2);
    expect(fixture.pages.every((page) => page.close.mock.calls.length === 1)).toBe(true);
    expect(fixture.contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it("uses one browser with bounded contexts for separate domains", async () => {
    const fixture = makeBrowserFixture();
    const session = createAgent3BrowserSession({
      launch: async () => ({ browser: fixture.browser, viewport: null }),
      maxActiveContexts: 2,
    });

    const first = await session.openPage("https://one.example/a");
    await first.close();
    const second = await session.openPage("https://two.example/b");
    await second.close();
    await session.close();

    expect(fixture.browser.newContext).toHaveBeenCalledTimes(2);
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    expect(fixture.contexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
  });

  it("retires only the affected domain context after a browser 429", async () => {
    const fixture = makeBrowserFixture();
    const session = createAgent3BrowserSession({
      launch: async () => ({ browser: fixture.browser, viewport: null }),
      maxNavigationsPerContext: 5,
    });

    const first = await session.openPage("https://publisher.example/a");
    await first.close({ retireContext: true });
    const second = await session.openPage("https://other.example/b");
    await second.close();
    await session.close();

    expect(fixture.browser.newContext).toHaveBeenCalledTimes(2);
    expect(fixture.contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(fixture.contexts[1]?.close).toHaveBeenCalledTimes(1);
  });

  it("retires a context when its navigation cap is reached", async () => {
    const fixture = makeBrowserFixture();
    const session = createAgent3BrowserSession({
      launch: async () => ({ browser: fixture.browser, viewport: null }),
      maxNavigationsPerContext: 1,
    });

    const first = await session.openPage("https://example.com/a");
    await first.close();
    const second = await session.openPage("https://example.com/b");
    await second.close();
    await session.close();

    expect(fixture.browser.newContext).toHaveBeenCalledTimes(2);
    expect(fixture.contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(fixture.contexts[1]?.close).toHaveBeenCalledTimes(1);
  });

  it("does not launch when the batch deadline is exhausted and closes exactly once", async () => {
    const fixture = makeBrowserFixture();
    const launch = vi.fn(async () => ({ browser: fixture.browser, viewport: null }));
    const session = createAgent3BrowserSession({ launch, deadlineAt: 1_000, now: () => 1_000 });

    expect(() => session.assertCanStart("https://example.com/a")).toThrowError(Agent3BrowserSessionError);
    await expect(session.openPage("https://example.com/a")).rejects.toMatchObject({ reason: "time_budget_exhausted" });
    await session.close();
    await session.close();

    expect(launch).not.toHaveBeenCalled();
    expect(fixture.browser.close).not.toHaveBeenCalled();
  });

  it("stops retrying browser launch after runtime unavailability", async () => {
    const launch = vi.fn(async () => ({ browser: null, blockedReason: "missing chromium" }));
    const session = createAgent3BrowserSession({ launch });

    await expect(session.openPage("https://example.com/a")).rejects.toMatchObject({ reason: "browser_runtime_unavailable" });
    await expect(session.openPage("https://example.com/b")).rejects.toMatchObject({ reason: "browser_runtime_unavailable" });
    await session.close();

    expect(launch).toHaveBeenCalledTimes(1);
  });
});
