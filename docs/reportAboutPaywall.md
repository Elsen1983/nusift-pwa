# Paywall classification and false-positive repair

**Status:** current implementation reference
**Updated:** 2026-08-09

This document describes the access-classification pipeline and the bounded workflow for auditing older records whose legacy `isPaywall` value may be a false positive. It replaces the earlier report that described whole-document `/paywall|subscribe|premium/` matching as the active design.

## 1. Classification model

The authoritative classifier is:

- `server/utils/news-pipeline/article-access-classification.ts`
- access detector version: `ARTICLE_ACCESS_DETECTOR_VERSION` (persisted under access evidence, separate from `extractorVersion`)

It returns one of:

- `ACCESSIBLE`
- `PAYWALL_BLOCKED`
- `METERED_OR_DECLARED`
- `INTERSTITIAL_OR_CHALLENGE`
- `HTTP_ACCESS_BLOCKED`
- `UNKNOWN`

The classifier returns bounded evidence codes, contradicting evidence, confidence, detector version, article-scoping information, body usability, and the compatibility `isPaywall` value.

Generic words such as `paywall`, `subscription`, `premium`, `subscriber`, `newsletter`, or `Netflix subscription` are context only. A generic `/paywall/i` test is not decisive evidence. The classifier requires article-specific access evidence for `PAYWALL_BLOCKED`.

## 2. Stage responsibilities

### Agent 1 and Agent 2

Ingest and discovery may emit early, bounded hints. They must evaluate only the current feed item or current discovered article candidate. They must not classify an entire RSS/XML/HTML document from navigation, footer, recommendation, newsletter, or unrelated page chrome.

Early evidence is preserved with:

- classification;
- `sourceStage` (`agent1` or `agent2`);
- evidence codes;
- contradicting evidence codes;
- detector version.

An early hint is not authoritative and does not by itself establish a blocking paywall.

### Agent 3

Agent 3 is authoritative. It evaluates the extracted body, selected article container, article-scoped CTA/gate evidence, structured metadata, HTTP result, browser result, and contradicting evidence. It may confirm, downgrade, or clear an early hint.

A substantial usable body with no article-scoped gate is strong accessibility evidence. A full readable body plus a genuine article-scoped restriction is `METERED_OR_DECLARED`, not a blocking overlay. Technical failures remain separate from paywalls.

## 3. Evidence rules

### Article-scoped runtime evidence

`PAYWALL_BLOCKED` requires article-specific access evidence together with a missing or materially truncated body. Examples include a subscription/login action inside the selected article gate or an adjacent gate proven to belong to that article.

Navigation, header/footer actions, account panels, login modals, advertisements, newsletter widgets, recommendations, and unrelated article cards are excluded structurally.

### Structured JSON-LD

JSON-LD is parsed safely and scoped to supported article nodes. `isAccessibleForFree:false` and `PaywalledContent` are honored only when the article identity matches or the page has a clearly related unstated single article node. Unrelated or conflicting article nodes do not create a blocking decision. Structured declaration alone normally yields `METERED_OR_DECLARED`.

### Technical access states

CAPTCHA, robot checks, JavaScript challenges, ad-blocker interstitials, HTTP 401/403, explicit request denial, and similar failures are not paywalls. They produce `INTERSTITIAL_OR_CHALLENGE` or `HTTP_ACCESS_BLOCKED` and do not infer `isPaywall=true`.

### Full-body contradiction

A substantial usable body is contrary evidence against a blocking paywall. Agent 3 can clear an earlier `true` compatibility value when the body is usable and no confirmed article-scoped blocking evidence remains. It does not clear a genuine truncated-body article gate merely because a short preview was exposed.

## 4. Compatibility mapping

The structured result maps to the legacy boolean as follows:

| Classification | `isPaywall` |
|---|---:|
| `PAYWALL_BLOCKED` | `true` |
| `METERED_OR_DECLARED` | `false` |
| `ACCESSIBLE` | `false` |
| `INTERSTITIAL_OR_CHALLENGE` | no inference (`null`) |
| `HTTP_ACCESS_BLOCKED` | no inference (`null`) |
| `UNKNOWN` | preserve the stronger existing value |

Public blocking UI is controlled only by the explicit structured check `accessClassification === "PAYWALL_BLOCKED"`. The legacy `isPaywall` boolean remains a persistence/API compatibility field; missing or malformed `accessClassification` must not fall back to `isPaywall=true`. `METERED_OR_DECLARED` is always readable and non-blocking. Its evidence remains available to Agent 3 diagnostics and admin inspection without covering a readable article.

## 5. Provenance and diagnostics

Agent 3 outcomes preserve bounded provenance in both the Article summary and detailed PipelineArtifact payload. Diagnostics include:

- previous and final `isPaywall`;
- early-stage classification and source;
- Agent 3 classification;
- access detector version (`ARTICLE_ACCESS_DETECTOR_VERSION`), kept separate from `extractorVersion`;
- confidence;
- evidence and contradicting evidence codes;
- usable body and article-scoped gate flags;
- override reason;
- bounded artifact-recovery status.

Raw HTML, full article text, credentials, cookies, authorization headers, and unredacted query values are not stored as evidence.

## 6. Existing-data repair workflow

The maintained entry point is:

- utility: `server/utils/news-pipeline/paywall-repair.ts`
- CLI: `scripts/repair-paywall-classification.ts`
- package command: `npm run db:paywall:audit`

Dry-run is the default and performs no Article updates, publication-state changes, or artifact writes. It scans only a bounded, deterministic set of existing `isPaywall=true` articles with stored body text and Agent 3 outcome status. It reports inspected counts, likely false positives, confirmed blocks, metered cases, unknown/skipped cases, access detector-version mismatches, per-source summaries, sanitized samples, proposed classifications, proposed boolean changes, and evidence codes.

Exact dry-run command:

```bash
npm run db:paywall:audit -- --limit=100
```

Local apply requires both the apply flag and exact token:

```bash
npm run db:paywall:audit -- \
  --apply \
  --confirmation=APPLY_PAYWALL_CLASSIFICATION_REPAIR \
  --limit=100
```

Apply mode is bounded, requires a local database by default, uses an optimistic current-row check, and creates one bounded `paywall_classification_repair` artifact per successfully updated article within the same transaction. A repair may update only `Article.isPaywall`, bounded `enrichmentOutcome.access`, bounded `paywallRepair` metadata, and `updatedAt` through the normal database update, plus that one artifact. It preserves the outcome kind, enrichment status, publication status, body text, and publication fields; it does not publish, reject, delete, or automatically re-enrich articles. Repeated application is idempotent because repaired rows no longer match the `isPaywall=true` scan and the current-state check fails closed.

Production mode is deliberately blocked unless all of the following are explicitly supplied:

- `--production`;
- `--production-confirmation=PRODUCTION_PAYWALL_CLASSIFICATION_REPAIR`;
- `PAYWALL_REPAIR_ALLOW_PRODUCTION=true`.

No production repair has been executed. Commented or copied environment values are never treated as authorization.

Automatic `true -> false` repair requires all of:

- substantial stored body (`hasUsableAgent3BodyText`, currently 500+ usable characters);
- a coherent successful or supported partial Agent 3 outcome with substantial stored body text and valid current access evidence. Supported durable combinations are `SUCCESS + ENRICHED` and `LOW_CONTENT_QUALITY + ENRICHMENT_FAILED` when the stored body is substantially usable;
- current classifier `ACCESSIBLE` with `HIGH` confidence;
- no article-scoped gate;
- no confirmed blocking evidence;
- no same-time conflicting artifact history;
- Article row still matches the inspected `isPaywall=true` and `updatedAt` state.

Unknown, short-preview, HTTP-blocked, challenge, declared/metered, conflicting, malformed, and genuine blocking cases are skipped. In particular, `PAYWALL_BLOCKED` lifecycle outcomes fail closed and are not automatically rewritten.

## 7. Detector versioning and reprocessing

Agent 3 outcomes record the access classifier detector version under the bounded access evidence. Existing rows with another or missing access detector version are reported as access detector-version mismatches by the repair audit. `extractorVersion` and the access `detectorVersion` are separate version domains: Agent 3 persists `ARTICLE_ACCESS_DETECTOR_VERSION` under access evidence and never copies it into `extractorVersion`. The utility does not force a table-wide reprocess. Re-evaluation is explicit, bounded, and operator-triggered. Normal Agent 3 extractor-version selection remains available for its existing bounded enrichment queue.

## 8. Known limitations

- A stored body cannot recover evidence that was never captured in an older outcome or artifact.
- Ambiguous or malformed histories fail closed rather than being auto-repaired.
- A declaration can be visible to the reader while still representing publisher metering; it is intentionally not treated as a blocking overlay.
- The repair utility does not attempt live-network re-fetches and does not apply publisher-specific rules.
- The repair scan is bounded per invocation; operators must run separate explicitly bounded batches for larger reviews.

## 9. Validation fixtures

The classifier and repair tests include generic fixtures for:

- topic discussion of paywalls or Netflix subscriptions with a full readable body;
- quoted third-party subscription CTAs;
- navigation/footer CTAs;
- genuine article-scoped gates with truncated bodies;
- structured JSON-LD declarations;
- CAPTCHA, HTTP 403, and interstitial responses;
- Bytepoint-style accessible false-positive repair without a publisher-specific exception.
