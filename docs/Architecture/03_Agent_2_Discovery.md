# Agent 2: static discovery

## Responsibility

Agent 2 discovers article URLs for targets not adequately served by Agent 1. It uses static HTTP techniques first because they are cheaper and more reliable in serverless environments than browser execution.

## Discovery order

1. Resolve eligible targets from feed/productivity evidence and lifecycle state.
2. Fetch target/listing pages through governed network access.
3. Extract article-like links from HTML, metadata, JSON-LD, and relevant page structures.
4. Inspect sitemap candidates when available.
5. Apply domain/category scope, utility-path rules, shared URL policy, canonical checks, and freshness policy.
6. Evaluate candidate metadata and persist accepted article candidates.
7. Assess discovery quality from accepted/rejected/evaluated counts and evidence.

## Outcomes

- Productive static discovery persists candidates and resolves applicable pending markers.
- Weak, blocked, or empty discovery can create or refresh a `PENDING_HEADLESS` marker.
- Static evidence is retained for admin diagnosis and later browser comparison.
- Hard-source tracking represents targets where both ordinary static and browser recovery need further attention.

## Graphify entry points

- [[Graphify/article-discovery.ts.md|article-discovery.ts]]
- [[Graphify/discoverArticlesFromTarget().md|discoverArticlesFromTarget]]
- [[Graphify/article-url-policy.ts.md|article-url-policy.ts]]
- [[Graphify/url-policy-evaluation.ts.md|url-policy-evaluation.ts]]

#nusift #agent2 #discovery #static
