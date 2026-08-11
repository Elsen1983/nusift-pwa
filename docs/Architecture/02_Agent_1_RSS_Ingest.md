# Agent 1: RSS ingest

## Responsibility

Agent 1 resolves active source/category targets, uses an existing scoped feed when available, attempts feed discovery when needed, parses feed items, applies URL and freshness policy, deduplicates candidates, and persists valid articles.

## Main flow

1. `runAgent1Batch` resolves eligible targets and enforces target/time budgets.
2. Feed resolution prefers verified source/category RSS state and can probe declared links or common feed paths.
3. Parsed items are normalized to canonical candidate data.
4. Non-article URLs, out-of-scope items, stale dates, and duplicates are skipped with structured counters.
5. `persistCandidates` writes accepted candidates and reports inserted/skipped/failed counts.
6. A successfully resolved scoped RSS feed can resolve stale Agent 2 headless markers and hard-source profiles for the same target.
7. Deferred targets remain visible in Agent 1 progress and are prioritized by later batches.

## Failure and handoff

- Feed fetch/parse failure is recorded rather than silently treated as success.
- A target with no useful feed output can become eligible for Agent 2 discovery.
- Batch exhaustion defers remaining targets; it does not mark them completed.

## Durable evidence

- `Article` rows for accepted candidates.
- Agent 1 target outcome and candidate artifacts.
- `PipelineRun` summary and progress/deferred metadata.
- Feed status and scoped feed URL on source/category records.

## Graphify entry points

- [[Graphify/runAgent1Batch().md|runAgent1Batch]]
- [[Graphify/persistCandidates().md|persistCandidates]]
- [[Graphify/agent1-rss-cleanup.ts.md|agent1-rss-cleanup.ts]]
- [[Graphify/ingest.ts.md|ingest.ts]]

#nusift #agent1 #rss #ingest
