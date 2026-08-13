# Agent 1-2-3 Fix Plan Overview

## What the real problem is

The audit and remediation plan point to one main failure pattern:

- the pipeline can move an item into a "done" or "resolved" state before the database write that proves success has actually completed;
- Agent 3 can pick up the same article more than once because there is no durable claim or lease;
- the user feed can expose rows that are still candidates, incomplete, or semantically wrong;
- provenance can be written as an assumption instead of a verified fact.

That means the real issue is not a single broken function. It is a chain of false-success and weak handoff states across Agent 2, Agent 3, and the feed boundary.

## Fix order

1. Stop false terminal success states in Agent 2.
2. Make Agent 3 selection claim-based so only one worker can own an article at a time.
3. Add an explicit publication gate before articles can appear in the user feed.
4. Replace provenance fallbacks that guess with provenance fields that can express unknown values.
5. Add tests that fail on partial persistence, stale worker writes, and premature resolution.

## Acceptance standard

The fix is complete only when:

- a discovery result cannot be marked resolved unless the candidate persistence path succeeded;
- Agent 3 cannot overwrite a newer outcome with a stale run;
- the feed only returns publishable article rows;
- provenance does not assert RSS origin unless it is actually known;
- the tests cover real failure injection, not only mocked happy paths.

## Current next-repair execution order

The numeric filenames reflect when prompts were written, not the implementation
dependency order. Execute the remaining work in this order:

1. Repair 05 - cooldown-aware Agent 2 headless eligibility.
2. Repair 11 - daily workflow stage isolation and truthful degradation.
3. Repair 06 - stale claim and lease recovery integration.
4. Repair 07 - poison-row isolation and attempt/claim accounting.
5. Repair 15 - run productivity assertion and per-source funnel attribution.
6. Repair 08 - shared charset detection and decoding.
7. Repair 09 - Article identity and deduplication contract.
8. Repair 10 - feed productivity demotion and HTTP 403 policy.
9. Repair 12 - structured yield from already-fetched responses.
10. Repair 13 - Agent 2 known-URL prefilter and conditional HTTP memory.
11. Repair 14 - browser-last static fallback ladder.

Do not reimplement capabilities already present in the current repository:

- trusted JSON-LD `articleBody` extraction already exists, but Repair 12 may
  improve its selection over a weak DOM body;
- sitemap and news-sitemap discovery already exist and remain authoritative;
- browser paths already block common heavy file extensions, while Repair 14
  may extend this with tested `resourceType()`-based policy;
- Article already has composite source/date and category/date indexes, which
  Repair 09 must preserve rather than duplicate.
