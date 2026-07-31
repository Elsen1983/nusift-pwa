# Step 1: Fix Agent 2 persistence ordering and terminal states

## Problem

Agent 2 currently has a false-success risk:

- static discovery can advance marker or lifecycle state before article persistence is confirmed;
- the headless queue can mark a target `RESOLVED` even when `persistCandidates()` fails, as long as candidates were found in memory.

This makes the database and the queue state diverge.

## What must change

1. Persist discovered candidates first.
2. Confirm the persistence result.
3. Only then resolve stale markers or mark the target terminal.
4. If persistence fails, keep the target retryable and record a failure state that is not confused with success.

## Recommended state model

Use distinct states for:

- candidates discovered;
- persistence pending;
- persistence failed but retryable;
- resolved only after persistence succeeded.

Do not use `RESOLVED` as a generic "candidates were seen" flag.

## Implementation sequence

1. Reorder the static discovery flow so `persistCandidates()` happens before marker resolution.
2. Update the headless queue finalization so successful terminal status requires successful persistence, not just `candidates.length > 0`.
3. Add explicit failure status handling for persistence exceptions.
4. Preserve the original audit payload even when persistence fails, but do not treat that as completion.

## Tests to add or update

- persistence failure leaves the target retryable;
- marker resolution does not happen before candidate persistence;
- headless queue does not emit `RESOLVED` on persistence failure;
- retrying a failed target does not duplicate already persisted rows.


<!-- Prompt -->
You are working in the NuSift repository.

Task:
Fix the Agent 2 persistence and terminal-state logic so the system cannot report success before candidate persistence has actually succeeded.

Context:
There is a known issue where Agent 2 can resolve a target or mark it as terminal even if `persistCandidates()` failed. This creates a false-success state and can suppress retry.

Your job:
1. Inspect the actual Agent 2 implementation, especially:
   - `server/utils/news-pipeline/article-discovery.ts`
   - `server/utils/news-pipeline/article-discovery-headless-queue.ts`
   - any related artifact/state helper modules
2. Verify the real control flow from discovery to persistence to terminal status update.
3. Identify exactly where success can be reported too early.
4. Implement the smallest correct fix that ensures:
   - candidate persistence happens before terminal resolution
   - persistence failure keeps the target retryable
   - `RESOLVED` is only used when success is actually durable
   - headless/browser fallback does not mark a run successful if persistence failed
5. Add or update tests that prove:
   - persistence failure does not resolve the target
   - successful persistence can still resolve the target
   - retry does not duplicate already persisted rows

Rules:
- Be repo-specific and evidence-based.
- Do not speculate; inspect the actual code first.
- Prefer the minimal change that fixes the real bug.
- Keep admin/debug/audit data, but do not confuse it with success.

Output required:
- brief summary of the real bug
- files changed
- tests added or updated
- any residual risk
