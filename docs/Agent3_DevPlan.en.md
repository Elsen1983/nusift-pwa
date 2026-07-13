# Agent 3 - Per-user relevance scoring and feed ordering

## Dev Plan

## 1. Role in the pipeline

Agent 3 is responsible for evaluating already collected and optionally enriched articles using **per-user relevance scoring**.

This layer:

- does not ingest
- does not search RSS feeds
- does not perform enrichment
- does not handle long-term retention or lifecycle cleanup

Agent 3 has a clear MVP goal:

1. calculate per-user scores
2. personalize feed ordering
3. fall back to the legacy feed when no score exists yet

## 2. Why it should be separate from Agent 4

The earlier Agent 3 scope was too broad because it combined:

- relevance scoring
- archive / prune lifecycle
- retention policy
- social layer
- collaborative filtering
- advanced recommendation

That creates implementation and operational risk.

So the correct split is:

- **Agent 3**: scoring and feed ordering
- **Agent 4**: lifecycle, retention, archive / prune, and later social / advanced recommendation

## 3. Input and output

### 3.1 Input

Agent 3 input:

- user profile
- user source/category subscriptions
- `Article` records after Agent 1 / 2
- Agent 2 enrichment results if available
- `UserReadActivity`
- `Bookmark`
- later `ArticleRating`

### 3.2 Output

Agent 3 output:

- per-user score record
- feed ordering
- short score reason
- optional score breakdown for debugging

## 4. Fit with the current system

Verified current state:

- `User.topInterests` already exists
- `User.primaryRegion` already exists
- `UserReadActivity` already exists
- `Bookmark` already exists
- `ArticleRating` model exists, but it is not yet an active working pillar
- `/api/feed` is still legacy and subscription + date based

So:

- Agent 3 does not need to be designed from zero
- but personalization is not finished yet

### 4.1 Explicit upstream Agent 1 state

Agent 3 builds on an Agent 1 that already:

- stores raw / normalized / provenance-like data in artifacts
- saves source/category discovery evidence
- creates a hard-case queue for unresolved feed cases
- can use browser fallback for hard-case feed discovery
- can trigger a targeted pipeline rerun after successful hard-case resolution

This matters for Agent 3 because the scoreable article universe can expand over time on the same source/category target, not only during the first ingest pass.

## 5. Data model proposal

Agent 3 needs a new per-user score model.

### Recommended model: `ArticleScore`

Fields:

- `id`
- `userId`
- `articleId`
- `relevanceScore`
- `qualityScore`
- `freshnessScore`
- `interestScore`
- `sourceAffinityScore`
- `fatiguePenalty`
- `scoreReason`
- `scoreFactors` optional JSON
- `scoredAt`
- `lastInteractionAt`
- `lifecycleStage`

Required indexes:

- `(userId, relevanceScore)`
- `(userId, lifecycleStage, scoredAt)`
- unique `(userId, articleId)`

Note:

- Agent 3 should not use the global `Article.score` field as the primary per-user ranking source.
- the per-user score should live in a separate table.

## 6. Agent 3 responsibility boundary

### Agent 3 does

- builds scoring profiles
- creates user-source/category/article candidate sets
- calculates multi-factor scores
- creates feed ordering
- provides graceful fallback when no score exists

### Agent 3 does not do

- article retention deletion
- archive / prune cron
- hard delete
- social proof system
- collaborative filtering in the first version

## 7. Scoring factors

For the MVP, the following factors are enough:

1. **freshness**
2. **interest match**
3. **source affinity**
4. **content quality**
5. **fatigue penalty**

### 7.1 Freshness

- newer articles should get priority
- focus especially on the last 24-48 hours

### 7.2 Interest match

- based on `User.topInterests` and article title / tags / signals
- Agent 2 enriched content can be additional input

### 7.3 Source affinity

- inferred from bookmark / click / read activity
- a simple weighting model is enough at the beginning

### 7.4 Content quality

- Agent 2 enrichment confidence or quality
- if enrichment is not available, use a lower confidence but still allow scoring

### 7.5 Fatigue

- if too many articles from the same source arrive within a short time, apply a penalty

## 8. Triggers

### 8.1 Post-pipeline trigger

Agent 3 can run after Agent 1 / 2, but it does not need to rescore everything.

Correct approach:

- only the affected users
- only the fresh or changed articles
- only the affected source/category universe

### 8.2 Onboarding trigger

After onboarding or an interest update, an initial scoring pass is useful.

### 8.3 Full rescore is not the default

This is critical for DB cost.

Agent 3's default strategy should be:

- **incremental scoring**

not:

- full feed rescore on every trigger

### 8.4 Hard-case rerun compatible triggering

Because Agent 1 can trigger a targeted pipeline rerun after successful hard-case resolution, Agent 3 must be compatible with that pattern.

Therefore:

- the scoring trigger should not be limited to a "daily ingest" mindset
- it must accept that new articles may arrive in later rerun cycles
- the same source/category target may produce a larger article universe later
- score refresh can be based on:
  - new article appearance
  - relevant source/category involvement
  - Agent 2 enrichment changes

Agent 3 should never assume that an article universe that was not present in the first ingest cycle will never appear later.

## 9. Feed integration

The end goal of Agent 3 is to personalize `/api/feed`.

Recommended behavior:

1. if the user has no `ArticleScore` records yet, use the current legacy feed
2. if scores exist, the feed should primarily be built from them
3. articles without scores can appear at the end as a fallback

This is a good backward-compatibility decision.

## 10. DB usage strategy

This plan is only viable if it is very careful about query cost.

Required principles:

- incremental scoring
- limited per-user candidate set
- score cache or score table usage
- minimal select fields
- aggregated queries instead of many small ones
- do not rebuild the profile unnecessarily on every request

Recommended:

- profile cache / snapshot with 6-24 hour TTL
- feed request should not recalculate score, only read stored score

### 10.1 Use of upstream evidence

Agent 3 should not rely only on final `Article` field values if upstream signals are more useful for ranking.

Useful future score factors or debug factors can include:

- feed / source provenance
- category / source target relationship
- discovery confidence-like upstream metadata
- Agent 2 enrichment confidence
