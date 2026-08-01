import fs from "node:fs";

type JsdomModule = typeof import("jsdom");

const FALLBACK_USER_AGENT_STYLESHEET = [
  "html, body, article, main, section, div, p, blockquote, ul, ol, li { display: block; }",
  "script, style, template, noscript { display: none; }",
].join("\n");

let jsdomModulePromise: Promise<JsdomModule> | null = null;

/**
 * Loads jsdom without depending on its package CSS asset being present in a
 * serverless/workflow bundle. jsdom 29 reads that asset during module startup;
 * some bundlers preserve the JavaScript but omit the adjacent CSS file.
 */
export function loadJsdom(): Promise<JsdomModule> {
  if (jsdomModulePromise) return jsdomModulePromise;

  jsdomModulePromise = (async () => {
    const originalReadFileSync = fs.readFileSync;
    const guardedReadFileSync: typeof fs.readFileSync = ((path: Parameters<typeof fs.readFileSync>[0], options?: unknown) => {
      if (String(path).replace(/\\/g, "/").endsWith("/jsdom/browser/default-stylesheet.css") ||
          String(path).replace(/\\/g, "/").endsWith("/browser/default-stylesheet.css")) {
        try {
          return originalReadFileSync(path, options as never);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") throw error;
          return typeof options === "string" || (options && typeof options === "object" && "encoding" in options)
            ? FALLBACK_USER_AGENT_STYLESHEET
            : Buffer.from(FALLBACK_USER_AGENT_STYLESHEET);
        }
      }
      return originalReadFileSync(path, options as never);
    }) as typeof fs.readFileSync;

    fs.readFileSync = guardedReadFileSync;
    try {
      return await import("jsdom");
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  })().catch((error) => {
    jsdomModulePromise = null;
    throw error;
  });

  return jsdomModulePromise;
}
