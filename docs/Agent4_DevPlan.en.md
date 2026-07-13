# Agent 4 - Lifecycle, retention, and advanced recommendation layer

## Dev Plan

## 1. Why Agent 4 should be separate

The original Agent 3 scope became too large. Combining scoring MVP work with long-term content lifecycle handling would create too many responsibilities in a single layer.

That is why Agent 4 should be treated as a separate layer for:

- archive
- prune
- retention
- hiding older articles
- later social and advanced recommendation logic

## 2. Agent 4 input

- `Article`
- `ArticleScore`
- `UserReadActivity`
- `Bookmark`
- `ArticleRating` if it becomes active later
- retention policy configuration

## 3. Agent 4 responsibilities

### 3.1 Lifecycle decisions

- when an article should be archived
- when it should be hidden per user
- when it should be pruned from the feed

### 3.2 Retention and cleanup

- rules for handling old, unused articles
- per-user visibility lifecycle
- preparation of a global content cleanup policy

### 3.3 Advanced recommendation logic

Later phase examples:

- collaborative filtering
- social proof
- friends recommendation layer
- diversity balancing
- multi-day resurfacing strategy

## 4. What Agent 4 does not do

- feed discovery
- article enrichment
- primary score calculation

## 5. Why this split is better

If Agent 3 only handles scoring, then:

- optimization is simpler
- operations are cheaper
- debugging is easier

As a separate layer, Agent 4:

- can run less frequently
- can work with larger time windows
- can stay policy-oriented

## 6. Lifecycle principles

Per-user and global lifecycle should remain separate.

This means:

- just because an article is pruned for one user does not mean it should be removed for another user
- global deletion of the `Article` record should follow much stricter rules

## 7. Recommended states

Example per-user lifecycle stages:

- `ACTIVE`
- `RECOMMENDED`
- `ARCHIVED`
- `PRUNED`

Note:

- logically this status should belong next to `ArticleScore` or its successor, not inside the global `Article` record

## 8. Retention policy directions

Examples:

- move articles older than 7 days that were neither read nor saved into the background
- archive after a longer period
- prune when relevance is very low and there is no user signal at all

These rules should not be forced into the Agent 3 MVP.

## 9. Later advanced directions

- extra weight for "friends read this"
- reading patterns of similar users
- resurfacing less recent but highly affine articles
- source diversity policy

## 10. Runtime model

Agent 4 should not run in the request path.

Correct patterns:

- cron
- batch worker
- queue-triggered lifecycle pass

## 11. Final recommendation

Separating Agent 4 is justified.

This keeps the system clean:

1. Agent 1: discovery + ingest
2. Agent 2: enrichment
3. Agent 3: scoring + feed ordering
4. Agent 4: lifecycle + retention + advanced recommendation
