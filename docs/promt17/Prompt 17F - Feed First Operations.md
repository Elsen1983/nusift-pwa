# Prompt 17F - Feed-First Operations

## Policy

Agent 1 remains the primary ingestion path. Agent 2 runs only when the centralized `shouldRunAgent2Discovery()` policy returns `runAgent2: true`.

The default thresholds are:

- productive feed freshness: 24 hours from `lastProductiveAt`;
- repeated nonproductive escalation: 2 consecutive nonproductive runs;
- active `nextRetryAt`: authoritative feed cooldown; no duplicate feed probe or Agent 2 fallback is started.

The policy is evaluated independently for source targets and category targets. A productive source feed does not suppress a category whose own feed is missing, stale, rate-limited, or repeatedly nonproductive. A source feed is not treated as category coverage unless category scope evidence proves it.

## Registering A Feed

1. Register the verified RSS or Atom URL on the intended `NewsSource` or `SourceCategory` record through the existing feed-management/admin flow.
2. Preserve the target's normal `feedProvenance` and target identity. Do not add publisher URLs or exceptions to generic pipeline code.
3. Run the normal bounded Agent 1 target once.
4. Confirm the target's `rssStatus`, `currentFeedProductive`, `lastProductiveAt`, and `consecutiveNonProductiveRuns` values in the admin inspection view or a read-only database query.
5. Confirm that the next Agent 2 target-resolution diagnostic reports `productive_fresh_feed` and does not create a headless marker.

## Verification

For a source or category, verify:

- `currentFeedProductive = true`;
- `lastProductiveAt` is present and within 24 hours;
- `nextRetryAt` is null or in the past;
- `consecutiveNonProductiveRuns = 0` after a productive run;
- the Agent 2 skip diagnostic names the exact source/category target.

An active future `nextRetryAt` indicates a feed cooldown. It must suppress both another Agent 1 feed probe and Agent 2 listing/headless work until the timestamp expires.

## Rollback

If a feed mapping is incorrect, remove or replace it through the existing feed-management/admin flow. Do not edit generic Agent 2 logic and do not hardcode the publisher host. After changing the mapping, the productivity state is reset by the existing feed URL reset helper; run Agent 1 again and verify the new target's first productive result before relying on feed-first suppression.

Feed registration is data/configuration, not a publisher-specific code exception. This keeps the same policy applicable to all publishers and allows a source or category to recover when its feed changes.

No production feed registration, database migration, or pipeline execution is performed by this document.
