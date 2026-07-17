# Agent 2 - Web discovery and article acquisition for no-RSS sources

## Dev Plan

## 1. Role in the pipeline

The NuSift content pipeline is split into five layers:

1. **Agent 1**: source/category RSS discovery, feed ingest, candidate normalization, artifact evidence persistence
2. **Agent 2**: web discovery and article acquisition for sources where RSS is missing, weak, partial, or not trustworthy
3. **Agent 3**: article-level enrichment and content extraction on already stored candidate/article records
4. **Agent 4**: per-user relevance scoring and feed ordering
5. **Agent 5**: lifecycle, retention, archive/prune, and later social / advanced recommendation

Agent 2 is **not** an enrichment agent.
It does **not** primarily improve article body text or perform deeper page extraction for already known articles.
Its job is to discover article URLs from source websites when feed-based discovery is insufficient.

Agent 2 sits between:

- source-level discovery
- and article-level enrichment

It converts a source or category website into a structured set of article candidates that can be ingested in the same style as Agent 1.

## 2. Why this layer exists

Many publishers do not expose a stable RSS feed, or they expose feeds only partially.
Some sites:

- have no RSS at all
- expose different feeds per section
- hide feeds behind directory pages or navigational hubs
- dynamically render article lists
- change feed URLs frequently
- expose feeds that are not discoverable by simple path guessing

Agent 2 exists to cover these cases without forcing the system to be RSS-only.

The goal is to turn a source website into a reliable article candidate stream by exploring the site itself.

## 3. Input and output

### 3.1 Input

Agent 2 primarily consumes:

- `NewsSource` records with no proven RSS feed
- `SourceCategory` records with no proven RSS feed
- validated source URLs from the source manager
- upstream discovery evidence from Agent 1
- stored `PipelineArtifact` records that describe discovery context
- optional manual feed hints or discovery hints

Agent 2 should prefer:

- source root pages
- category pages
- section pages
- archive pages
- sitemap references
- navigation clusters
- pagination pages
- canonical article list pages

### 3.2 Output

Agent 2 output should include:

- `Article` records for newly discovered article URLs
- discovery evidence for the discovered article set
- structured artifact payloads
- candidate rejection / skip reasons
- provenance describing how each article was found
- optional queue entries for later reprocessing when the site structure changes

## 4. Responsibility boundary

### Agent 2 does

- explores websites where RSS is missing or not proven
- discovers article listing pages and section pages
- extracts article URLs from HTML, DOM, structured data, sitemap, and navigational hints
- validates article URLs before ingest
- normalizes and stores article candidates in the same general shape as Agent 1
- preserves provenance for every discovered article
- stores structured success, skip, and rejection outcomes
- supports browser-based fallback for dynamic sites

### Agent 2 does not do

- RSS feed discovery as the primary task
- article body enrichment
- per-user ranking
- lifecycle / archive / prune
- deep content rewriting
- heavy user-specific personalization

Important:

- Agent 2 may still use browser execution
- but only as a discovery tool, not as a general article processor

## 5. What Agent 2 must preserve

Agent 2 should preserve the same audit principles already used by Agent 1:

- what page was inspected
- what article URLs were found
- what selectors or signals led to each article URL
- what was rejected and why
- what was normalized
- what was duplicated
- whether discovery came from fetch, sitemap, DOM, or browser rendering

The output must remain inspectable.
The user should be able to answer:

- why was this article discovered?
- where did it come from?
- how was it validated?
- why was another candidate rejected?

## 6. Discovery strategy

Agent 2 should use a layered discovery strategy.

The default path must remain deterministic and cheap. Agent 2 should not
depend on a general AI browser agent as its normal daily ingest engine.
Browser or AI-assisted tools are fallback and repair layers, not the primary
pipeline path.

### 6.1 Fast fetch-based discovery

Start with cheap discovery:

- HTML fetch
- DOM parsing and link extraction
- header and meta parsing
- canonical link hints
- structured data extraction
- sitemap discovery
- navigation menu inspection
- archive / category / tag pages
- pagination scanning

Recommended default implementation tools:

- `safeFetch` for network access and SSRF protection
- `JSDOM` or a comparable static HTML parser for DOM inspection
- bounded internal link traversal
- article-link scoring before detail-page fetches
- the same candidate persistence shape used by Agent 1

### 6.2 Site-structure discovery

If the initial fetch is not enough, inspect:

- section pages
- related pages
- local navigation clusters
- listing cards
- category hubs
- “latest news” blocks
- archive indexes
- date-based indexes

### 6.3 Browser fallback

If the site is dynamic or partially rendered:

- use Playwright-style browser rendering
- inspect hydrated DOM
- inspect client-side route data
- inspect dynamically injected listing cards
- inspect pagination generated by JS

Browser use should be bounded, target-scoped, and cost-aware. It should run
only after static fetch/DOM discovery fails or produces low-confidence results.

### 6.4 AI-assisted inspection

Browser Use, Stagehand, or similar AI-assisted browser tooling should not run
inside the normal daily ingest path.

Their recommended role is:

- admin repair workflow for hard sources
- one-time site structure exploration
- selector or extraction-profile proposal
- source onboarding support

If AI-assisted inspection discovers a useful pattern, the output should become
a deterministic extraction rule or profile that future runs can execute without
needing an AI browser session.

### 6.5 Controlled crawl expansion

When needed, Agent 2 may expand the search from the root or category page into a bounded crawl:

- follow internal section links
- follow archive links
- follow pagination
- follow same-domain article listing pages

The crawl must remain bounded and deterministic.

## 7. Discovery outcome model

Agent 2 should produce structured discovery outcomes.

Recommended outcome categories:

- `DISCOVERED`
- `DISCOVERED_FROM_SECTION`
- `DISCOVERED_FROM_ARCHIVE`
- `DISCOVERED_FROM_NAVIGATION`
- `DISCOVERED_FROM_SITEMAP`
- `DUPLICATE`
- `INVALID_URL`
- `UNSUPPORTED_STRUCTURE`
- `BROWSER_REQUIRED`
- `NO_ARTICLES_FOUND`
- `LOW_CONFIDENCE`

Each outcome should keep:

- the inspected page
- the candidate article URL
- the reason for acceptance or rejection
- the method used
- the confidence level

## 8. Input shape and output shape

### 8.1 Input expectations

Agent 2 should not assume the source URL is already a clean article listing.

The input may be:

- a root domain
- a category path
- a section path
- a directory page
- a weakly structured listing page

### 8.2 Output expectations

Agent 2 should insert article candidates in a structured shape similar to Agent 1:

- `title`
- `canonicalUrl`
- `publishedAt`
- `sourceId`
- `categoryId`
- `tags`
- `discoveryEvidence`
- artifact payload

Agent 2 should not require full body text to store a discovered article.

That belongs later to Agent 3.

## 9. Artifact strategy

Agent 2 should have its own artifact types.

Recommended artifact types:

- `article_discovery_attempt`
- `article_discovery_result`
- `article_discovery_rejection`
- `article_discovery_browser_candidate`

Artifact payload should contain:

- input source or category
- inspected page URL
- discovered article URLs
- selector / route / sitemap evidence
- browser fallback metadata if used
- per-candidate confidence
- rejection reasons
- timing

## 10. Data model expectations

Agent 2 will likely need some additional fields or structured JSON support for:

- discovery status
- discovery attempt count
- discovery started / finished timestamps
- discovery method
- discovery confidence
- discovery evidence
- last productive discovery URL
- current feed / discovery productivity flag
- queue / retry metadata

Recommended states:

- `PENDING_DISCOVERY`
- `DISCOVERING`
- `DISCOVERED`
- `DISCOVERY_FAILED`
- `DISCOVERY_QUEUED_BROWSER`
- `NO_ARTICLES_FOUND`

## 11. Runtime model

### 11.1 Batch first

Agent 2 should run as a batch or queue-driven process.

Better flow:

1. Agent 1 runs and processes RSS-backed targets
2. sources with no proven RSS are selected for Agent 2
3. Agent 2 discovers article URLs from the source website
4. discovered articles are stored as structured records
5. the same article universe becomes available for later Agent 3 enrichment

### 11.2 Compatibility with Agent 1 reruns

Agent 2 must remain compatible with Agent 1 targeted reruns.

That means:

- a source that originally had no articles may later yield articles
- a source whose discovery improved later must be re-eligible
- discovery should not assume the first attempt is the final truth

### 11.3 Selection rules

Agent 2 should only run on targets that:

- are active
- are user-linked
- do not already have a trusted RSS path taking priority
- are either root sources or category sources needing web discovery
- are not already successfully discovered recently

## 12. Discovery and validation rules

Agent 2 should:

- validate same-domain article URLs
- reject off-domain links
- reject obvious non-article utility pages
- deduplicate canonical URLs
- avoid overcounting query variants
- preserve the original source/category context

Special cases:

- source pages may map to several category feeds or listing branches
- a root source may contain more than one important section
- a category source may be deeper than one path segment
- the same site may expose both section-level and root-level article hubs

## 13. DB usage principles

Since DB cost matters in this project, Agent 2 should be designed like this:

- batch queries, not per-URL row lookups
- minimal select fields
- evidence mostly in artifact payloads
- only update rows when a real discovery improvement happens
- keep detailed scanning state in structured JSON / artifacts
- avoid a full crawl loop that performs one DB write per page visited
- avoid running Playwright or AI-assisted inspection for every target in normal daily runs

## 14. Security and stability

Required:

- same-domain policy
- private IP blocking
- redirect validation
- timeout and abort handling
- browser use only when needed
- AI-assisted browser use only as an admin/repair workflow
- max depth / max pages / max article limit
- duplicate protection
- canonical URL normalization

## 15. MVP implementation order

### Phase 1

- source/category discovery scaffolding
- fast HTML / sitemap / navigation-based article discovery
- structured article candidate persistence
- discovery artifact persistence
- rejection / skip reasons
- separate dev trigger

### Phase 2

- directory / archive / pagination traversal
- confidence scoring
- better duplicate filtering
- target-aware orchestration after Agent 1
- Playwright fallback for dynamic listing pages

### Phase 3

- queue-based reprocessing
- site structure change recovery
- headless browser worker preparation
- reusable extraction profiles for sources where static discovery needs learned selectors

## 16. Open decision points

- should Agent 2 discover from root only, or also recursively from section pages
- how aggressive the bounded crawl should be
- whether the discovered article set should be stored as a dedicated table or artifact-first
- how to distinguish “no articles found” from “not yet crawled deeply enough”
- whether browser fallback should use a dedicated worker from the start
- when a failed target should be escalated from static discovery to Playwright
- what approval flow should exist before AI-assisted inspection creates reusable extraction profiles

## 17. Final recommendation

The correct role of Agent 2 is:

- discover articles from websites where RSS is absent or unreliable
- use cheap fetch-first discovery as the default path
- use Playwright fallback only when static discovery is insufficient
- reserve Browser Use / Stagehand-style tooling for admin repair and profile discovery
- store structured article candidates in the same audit-friendly style as Agent 1
- preserve provenance and avoid full article enrichment
- prepare a clean input set for Agent 3

Agent 2 will only be stable if it remains a discovery layer, not an enrichment layer.
It should complement Agent 1, not duplicate it.
