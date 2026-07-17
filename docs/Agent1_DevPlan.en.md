# Agent 1 - Source discovery, feed ingest, and artifact evidence

## Dev Plan

## 1. Role in the system

Agent 1 is the entry point of the NuSift content pipeline.

Its responsibilities are:

- handling source/category targets that are linked to users
- feed discovery
- RSS / Atom / JSON feed ingest
- candidate normalization
- first-time article persistence
- evidence and artifact payload persistence

In the current system, this is no longer only a plan. It is already partially implemented as architecture.

## 2. Core responsibilities

### 2.1 Source and category discovery

- root source feed discovery
- category feed discovery
- autodiscovery
- known feed path heuristics
- sitemap / HTML based candidate feed discovery
- scoped category feed priority

### 2.2 Feed ingest

- RSS
- Atom
- JSON feed or similar supported structures
- HTML fallback only under strict rules

### 2.3 Candidate normalization

- raw title/body persistence
- normalized title/body persistence
- encoding normalization
- canonical URL normalization
- source/category provenance
- rejection and skip reason persistence

### 2.4 Persistence and observability

- `Article`
- `PipelineRun`
- `PipelineArtifact`
- `NewsSource.discoveryEvidence`
- `SourceCategory.discoveryEvidence`
- `AgentScanLog`

## 3. The correct architectural principle today

Agent 1 is **not a per-user feed crawler**. It is a shared ingest layer that works across:

- active
- truly user-linked
- active-status

source/category targets in the system.

This matters because:

- inactive or unused sources do not need to be run
- suspended / restricted targets should not be processed unnecessarily
- ingest output should form a shared content pool for downstream agents

## 4. Input and output

### Input

- `NewsSource`
- `SourceCategory`
- active `UserSourceSubscription`
- active `UserCategorySubscription`

### Output

- `Article` records in `INGESTED` state
- discovery evidence
- pipeline artifact payloads
- candidate provenance and normalization metadata

## 5. Mandatory evidence model

Agent 1 is valuable not only because it creates article records.

It must preserve:

- what it found in the feed
- what it normalized from
- what it dropped
- why it dropped it
- where each candidate came from
- how confident the feed discovery was

That is why raw / normalized / provenance logic is the foundation of Agent 1.

This is also the input for later Agent 3 and Agent 4 work.

## 6. Candidate outcome types

Agent 1 output should be handled in a structured way.

Recommended categories:

- accepted candidate
- duplicate candidate
- stale candidate
- invalid URL candidate
- feed-level rejected candidate
- HTML fallback candidate
- scoped category candidate

Where possible, this should also be visible in artifact payloads.

## 7. Content age limit

The ingest should allow only articles that are at most about 1 week old relative to the current run time, so that:

- the DB does not fill up with very old articles
- later scoring works on a fresher dataset
- retention logic becomes simpler

## 8. Discovery quality principles

Agent 1 feed discovery should:

- prefer the real feed URL over a root fallback
- handle category-specific feeds
- avoid false positives such as contact/about/newsletter/search URLs
- handle blocked / WAF / forbidden cases separately

## 9. Current extra layers in Agent 1

Agent 1 is now more than a simple "feed discovery -> article insert" pipeline.

Verified additions:

- `PipelineRun` and `PipelineArtifact` based run tracking
- hard-case discovery artifact queue for unresolved feed cases
- browser fallback for hard-case feed discovery
- source/category discovery evidence persistence
- targeted pipeline rerun after successful hard-case resolution

This is important because Agent 1 has become a two-phase ingest layer:

1. normal discovery + ingest pass
2. hard-case discovery + targeted rerun

## 10. Hard-case discovery model

If normal discovery does not find a suitable feed, Agent 1 should not stop at a simple error log.

Correct model:

1. a failed or weak discovery creates a hard-case artifact
2. the hard-case queue can be processed separately
3. the hard-case consumer first uses the same discovery logic
4. if that still fails, browser fallback is attempted
5. the resolved result is stored as both discovery evidence and artifact payload

Benefits:

- the normal ingest remains cheap
- hard cases can be handled separately
- it is easier to audit why the simple discovery was not enough

## 11. Browser fallback principles

The browser fallback in Agent 1 is still a discovery capability, not a general article renderer.

Its job is to:

- uncover feed candidates that exist in HTML but are weakly visible to plain fetch discovery
- use inline scripts, DOM, structured state, route and meta signals
- feed candidates back into the normal verification pipeline

Important limitation:

- this still does not mean Agent 1 performs full article body extraction
- the browser fallback is for feed discovery
- full article enrichment remains the job of Agent 3

## 12. Resolver metadata and discovery evidence

Agent 1 can now store discovery path quality explicitly in discovery evidence and artifact payloads.

Important metadata examples:

- `resolverPath`
- `browserAttempted`
- `browserMethod`
- `browserCandidateCount`
- `browserCandidates`
- `browserError`

This is useful because:

- it shows whether fetch or browser fallback solved the target
- Agent 3 and Agent 4 can later use it as upstream context
- dev and audit views can show which targets are difficult

## 13. Targeted rerun model

After a successful hard-case resolution, Agent 1 should not trigger a global pipeline rerun. It should trigger a targeted rerun.

Correct rule:

- for a source target, rerun only that source
- for a category target, rerun only the parent source plus that category
- do not fall back to rerunning all active sources

This matters because:

- it keeps DB load under control
- it avoids needlessly broadening the pipeline scope
- it gets the newly discovered feed ingested faster

## 14. Production principles

Agent 1 should be:

- cheap
- idempotent
- auditable
- queue-compatible
- a reliable input layer for the other agents

This is especially important now that the hard-case queue and targeted rerun are part of the pipeline.

## 15. What must not be placed in Agent 1

- full article body extraction
- general article enrichment
- per-user ranking
