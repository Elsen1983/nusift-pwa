# URL policy

## Purpose

The shared URL policy rejects obvious non-article routes before they become article candidates while preserving strong article evidence. It is used by Agent 1 feed ingest and Agent 2 listing/sitemap/metadata evaluation.

## Production behavior

- `classifyArticleUrl` evaluates positive and negative URL signals.
- `evaluateProductionUrlPolicy` is side-effect-free and suitable for offline baseline evaluation.
- Existing boolean callers remain compatibility wrappers around the production decision.
- Candidate/shadow evaluation may record alternative decisions but must not change production gating while in shadow mode.

## Typical negative evidence

Media clips, feeds, archives, search, account/private flows, checkout/referral paths, author/profile pages, topics/tags/categories, embeds, and utility pages.

## Typical positive evidence

Date paths, article suffixes, stable numeric IDs, long descriptive slugs, and article-like route segments. Strong negatives must not be overridden by generic path depth alone.

## Graphify entry points

- [[Graphify/classifyArticleUrl().md|classifyArticleUrl]]
- [[Graphify/evaluateProductionUrlPolicy().md|evaluateProductionUrlPolicy]]
- [[Graphify/url-policy-evaluation-runner.ts.md|evaluation runner]]
- [[Graphify/url-policy-decision-observer.ts.md|shadow observer]]

#nusift #url-policy #quality #shadow
