# Step 2: Add Agent 3 claims and stale-write protection

## Problem

Agent 3 selects eligible articles without a durable claim or lease.

That creates these risks:

- two workers can process the same article concurrently;
- a stale worker can write a later result over a newer success;
- attempt counts and final outcome artifacts can drift apart from the effective winner.

## What must change

1. Add a claim token and lease fields to `Article`, or move claims into a dedicated attempt table if that is cleaner for auditing.
2. Claim an article with a compare-and-set update before extraction begins.
3. Require the claim token on the final update so only the owning worker can persist success or failure.
4. Recover expired claims explicitly instead of letting them linger.

## Implementation sequence

1. Add claim fields and indexes if needed.
2. Update article selection so eligible rows are claimed before work starts.
3. Reject final writes when the claim token does not match.
4. Add recovery logic for expired claims.
5. Update progress counters to reflect claim failures and stale-worker skips.

## Tests to add or update

- two workers cannot claim the same article;
- a stale worker cannot overwrite a newer result;
- expired claims become eligible again;
- attempt counts remain correct after retries and claim loss;
- the final artifact always matches the winning row update.

<!-- Prompt -->
You are working in the NuSift repository.

Task:
Make Agent 3 safe against concurrent processing and stale writes.

Context:
The current risk is that Agent 3 selects eligible articles without a durable claim or lease, so two workers can process the same article and a stale worker may overwrite a newer result.

Your job:
1. Inspect the actual Agent 3 runtime and persistence code, especially:
   - `server/utils/news-pipeline/enrichment-runtime.ts`
   - `server/utils/news-pipeline/enrichment-persist.ts`
   - any selection, claim, retry, or progress helpers
2. Confirm how articles are currently selected and written back.
3. Implement claim-based protection so that:
   - only one worker can own an article at a time
   - final writes require the matching claim/token
   - stale workers cannot overwrite newer success or failure states
   - expired claims can be recovered explicitly
4. Update progress/attempt handling so counters stay correct after claim loss or retry.
5. Add tests that prove:
   - two workers cannot claim the same article
   - a stale worker cannot overwrite a newer result
   - expired claims become eligible again
   - final artifact and row state remain consistent

Rules:
- Check the repo’s current schema and migrations before proposing a schema change.
- If a dedicated claim table is cleaner than row fields, justify it based on the repo’s current structure.
- Keep the fix durable and auditable.
- Do not weaken the current retry/cooldown behavior unless necessary.

Output required:
- what the real concurrency failure was
- what claim mechanism you used
- files changed
- tests added or updated
- any migration/schema impact