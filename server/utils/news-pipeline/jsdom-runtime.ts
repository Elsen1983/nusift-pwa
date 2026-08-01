type JsdomModule = typeof import("jsdom");

let jsdomModulePromise: Promise<JsdomModule> | null = null;

/**
 * Shares one server-side jsdom module load across concurrent extractions.
 * jsdom is pinned to a serverless-safe release because newer versions load
 * package-adjacent CSS/JSON assets that the Workflow bundler does not retain.
 */
export function loadJsdom(): Promise<JsdomModule> {
  if (jsdomModulePromise) return jsdomModulePromise;

  jsdomModulePromise = import("jsdom").catch((error) => {
    jsdomModulePromise = null;
    throw error;
  });

  return jsdomModulePromise;
}
