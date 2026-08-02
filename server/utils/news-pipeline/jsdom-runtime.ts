import { parseHTML } from "linkedom";

type DomOptions = {
  url?: string;
  contentType?: string;
  pretendToBeVisual?: boolean;
};

type DomWindow = Window & typeof globalThis & { close(): void };

/**
 * Minimal JSDOM-compatible facade backed by linkedom.
 *
 * jsdom resolves a package-adjacent synchronous XHR worker during module
 * initialization. Vercel Workflow bundles that module into /var/task/index.js,
 * where the adjacent worker asset does not exist. The extraction pipeline does
 * not execute scripts or synchronous XHR, so linkedom provides the DOM surface
 * it needs without runtime filesystem assets.
 */
class ServerlessDom {
  readonly window: DomWindow;

  constructor(html: string, options: DomOptions = {}) {
    const parsed = parseHTML(html);
    const document = parsed.document;

    if (options.url && !document.querySelector("base[href]")) {
      const base = document.createElement("base");
      base.setAttribute("href", options.url);
      const head = document.head ?? document.documentElement;
      head.prepend(base);
    }

    const window = parsed.window as unknown as DomWindow;
    if (typeof window.close !== "function") {
      window.close = () => undefined;
    }
    this.window = window;
  }
}

export type ServerlessDomModule = { JSDOM: typeof ServerlessDom };

const serverlessDomModule: ServerlessDomModule = { JSDOM: ServerlessDom };

/** Return the bundle-safe DOM parser used by Agent 3 extraction. */
export function loadJsdom(): Promise<ServerlessDomModule> {
  return Promise.resolve(serverlessDomModule);
}
