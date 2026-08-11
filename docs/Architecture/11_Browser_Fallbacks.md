# Browser fallbacks

## Role

Browser fallback is a recovery mechanism, not the primary fetch path. It is reserved for evidence that rendered execution can plausibly recover content or links unavailable through static HTTP.

## Agent 2 browser path

- Operates on durable `PENDING_HEADLESS` target markers.
- Renders listing pages, filters/shortlists links, evaluates article metadata, and persists candidates.
- Uses bounded attempts, cooldowns, atomic claims, and final artifact transitions.

## Agent 3 browser path

- Operates on article extraction failures eligible for browser recovery.
- Renders the article and sends resulting HTML through the shared extraction and quality pipeline.
- Records attempted/succeeded/skipped reason, HTTP evidence, runtime availability, diagnostics, and source cooldown effects.

## Runtime strategy

Local Docker runners provide Chromium/Playwright parity. Serverless execution must remain bounded because browser startup, memory, wall-clock limits, and publisher blocking are less predictable than static fetch.

## Graphify entry points

- [[Graphify/article-discovery-browser.ts.md|Agent 2 browser discovery]]
- [[Graphify/article-content-browser-extractor.ts.md|Agent 3 browser extraction]]
- [[Graphify/launchBrowser().md|launchBrowser]]
- [[Graphify/isBrowserFallbackEnabled().md|isBrowserFallbackEnabled]]

#nusift #browser #playwright #fallback
