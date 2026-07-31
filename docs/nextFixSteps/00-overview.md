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
