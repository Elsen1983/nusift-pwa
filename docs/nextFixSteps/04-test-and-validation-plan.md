# Step 4: Validation plan

## Goal

Prove the pipeline is safe under the cases that caused the audit findings.

## Required validation

1. Inject a database failure during Agent 2 candidate persistence.
2. Confirm the queue does not claim success in that case.
3. Run two Agent 3 workers against the same article and confirm only one can complete.
4. Force a stale Agent 3 result and confirm it cannot overwrite a newer success.
5. Confirm unpublished or incomplete rows do not reach the feed.
6. Confirm provenance fallback no longer asserts RSS origin when origin is unknown.

## Pass criteria

- no false terminal success;
- no concurrent double-write on the same article;
- no user-visible incomplete content;
- no provenance claims without evidence;
- tests cover the real production flow, not only isolated helper logic.

<!-- Prompt -->
You are working in the NuSift repository.

Task:
Build or update validation coverage that proves the Agent 1/2/3 fixes work in the real pipeline, including failure injection and concurrency edge cases.

Context:
The main risk is not just ordinary logic bugs. It is false-success states, stale-worker overwrites, and user-visible incomplete data that only show up under failure or concurrency.

Your job:
1. Inspect the existing tests and identify which production paths are actually covered.
2. Add or update tests that exercise the real behavior, not only isolated helpers.
3. Cover these cases:
   - Agent 2 persistence fails after discovery
   - Agent 2 does not resolve before persistence succeeds
   - Agent 3 stale worker cannot overwrite a newer success
   - Agent 3 claim loss is handled safely
   - feed excludes non-publishable rows
   - provenance fallback does not lie
4. If necessary, add integration-style tests that use the actual persistence path and not only mocks.
5. Summarize which risks are now proven and which remain unverified.

Rules:
- Use the actual repo structure.
- Prefer targeted, high-value tests over broad superficial coverage.
- State clearly when a test is unit-level vs integration-level.
- If a real concurrency/integration test is expensive, document the limitation and the closest practical coverage.

Output required:
- test coverage gaps found
- tests added or updated
- which failure modes are now proven
- what still remains a risk