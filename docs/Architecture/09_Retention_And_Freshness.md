# Retention and freshness

## Shared policy

The article retention policy is the canonical time window used across ingestion, discovery, enrichment selection, and cleanup. This prevents a cleanup/re-import loop in which one stage deletes content that another stage immediately treats as eligible history.

## Application

- Agent 1 skips feed/HTML items with parseable dates outside the window.
- Agent 2 rejects stale article metadata and does not allow weak-date logic to bypass a known old date.
- Agent 3 limits enrichment scope to retained articles.
- Maintenance deletes old, unowned articles only when no protected user relation requires retention.

## Date uncertainty

Missing or invalid dates are tracked separately from known-stale dates. Unknown date handling may be weaker than a known fresh date, but a parseable stale date must remain a hard freshness signal.

## Graphify entry points

- [[Graphify/article-retention-policy.ts.md|article-retention-policy.ts]]
- [[Graphify/article-retention-cleanup.ts.md|article-retention-cleanup.ts]]
- [[Graphify/processOldArticleRetentionCleanup().md|processOldArticleRetentionCleanup]]
- [[Graphify/maintenance-cleanup-runner.ts.md|maintenance-cleanup-runner.ts]]

#nusift #retention #freshness #cleanup
