# Network governance and cooldowns

## Purpose

Shared network governance limits repeated requests to publishers, represents rate limits as durable defer decisions, and prevents one blocked domain from consuming an entire batch.

## Core behavior

- Governed fetch checks domain state and request budget before network work.
- HTTP 429 is a cooldown/defer signal, not permission for immediate aggressive browser escalation.
- Repeated 403 responses can trigger source cooldown according to stage policy.
- Browser-runtime unavailability can stop further browser attempts without preventing unrelated static work.
- Per-run source diversity and persistent evidence make failures visible across invocations.

## Failure semantics

- A governor persistence failure must not be silently converted into ordinary publisher failure.
- Cooldown-skipped work remains pending/retryable where appropriate.
- Admin output should show retry time, reason, last attempt, and skipped counts.

## Graphify entry points

- [[Graphify/governed-fetch.ts.md|governed-fetch.ts]]
- [[Graphify/governedSafeFetch().md|governedSafeFetch]]
- [[Graphify/SourceCooldownTracker.md|SourceCooldownTracker]]
- [[Graphify/domain-request-governor.ts.md|domain-request-governor.ts]]

#nusift #network #cooldown #rate-limit
