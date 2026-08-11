# Agent 3: extraction and enrichment

## Responsibility

Agent 3 enriches persisted articles with usable article body text and metadata. It does not treat an excerpt, meta description, interstitial, or HTTP block page as a successful full-body extraction.

## Main flow

1. Select articles within the retention window that need initial enrichment, current extractor-version reprocessing, or an allowed retry.
2. Exclude current-version permanent failures unless force reprocessing or explicit article IDs override normal policy.
3. Defer recently blocked 403/429/runtime failures until their retry window expires.
4. Apply source diversity and per-source limits to prevent one publisher dominating a batch.
5. Claim articles so concurrent workers do not enrich the same rows.
6. Fetch static HTML and classify access state.
7. Build body candidates from semantic DOM containers, custom scoring, expansion, and Mozilla Readability output.
8. Reject excerpt-only, too-short, boilerplate-heavy, paywalled, canonical-mismatch, unsupported, or HTTP-blocked results.
9. Optionally attempt browser extraction for specifically eligible failures within browser and source budgets.
10. Persist improved fields, body text, provenance, outcome metadata, diagnostics, artifacts, and run summary.

## Retry model

- Extractor version changes make older outcomes eligible for controlled reprocessing.
- `HTTP_ACCESS_BLOCKED` remains retryable after cooldown.
- Current-version structural/quality failures are not retried forever by ordinary runs.
- Force reprocess only overwrites existing body text when the new extraction is materially better.

## Graphify entry points

- [[Graphify/runEnrichmentBatch().md|runEnrichmentBatch]]
- [[Graphify/enrichment-runtime.ts.md|enrichment-runtime.ts]]
- [[Graphify/article-content-extractor.ts.md|article-content-extractor.ts]]
- [[Graphify/article-content-browser-extractor.ts.md|article-content-browser-extractor.ts]]

#nusift #agent3 #extraction #enrichment
