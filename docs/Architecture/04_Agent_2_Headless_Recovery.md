# Agent 2: headless recovery

## Responsibility

The headless queue recovers targets whose static discovery was weak, blocked, or dynamically rendered. Browser work is separate from ordinary Agent 2 discovery so it can run in a compatible runtime and remain tightly bounded.

## Queue lifecycle

1. A static failure/weak result creates or refreshes a `PENDING_HEADLESS` artifact.
2. The processor scans a wider window but limits actual browser attempts.
3. A compare-and-set transition claims `PENDING_HEADLESS` as processing, preventing duplicate workers from owning the same artifact.
4. Active target/domain cooldowns defer work without consuming the browser-attempt cap.
5. Browser-rendered links are shortlisted, metadata-evaluated, and persisted using the same downstream candidate rules.
6. Final state reflects durable persistence and effective browser outcome, not merely discovered link count.

## Recovery behavior

- HTTP 429 creates retry/cooldown evidence instead of aggressive immediate retries.
- Runtime-unavailable and transition-conflict cases remain observable and recoverable.
- Successful browser candidates can resolve the marker.
- Zero accepted candidates can create/update a hard-source profile when static quality was also weak.
- Agent 1 later discovering a valid scoped RSS feed can resolve obsolete headless state.

## Graphify entry points

- [[Graphify/processArticleDiscoveryHeadlessQueue().md|processArticleDiscoveryHeadlessQueue]]
- [[Graphify/article-discovery-headless-queue.ts.md|article-discovery-headless-queue.ts]]
- [[Graphify/discoverArticleLinksWithBrowser().md|discoverArticleLinksWithBrowser]]
- [[Graphify/headless-queue-artifact.ts.md|headless-queue-artifact.ts]]

#nusift #agent2 #browser #headless
