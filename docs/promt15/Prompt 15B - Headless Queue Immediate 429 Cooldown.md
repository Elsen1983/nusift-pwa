Prompt 15B - Headless Queue Immediate 429 Cooldown

Implement the Agent 2 headless-queue correction for static detail HTTP 429 outcomes.

Prompt 1 has already introduced structured static rate-limit evidence and bounded static discovery behavior. Reuse that implementation. Do not introduce a second incompatible 429 representation.

This task is limited to the Agent 2 headless/browser queue and its artifact lifecycle.

Verified problem

During headless queue processing, each browser-discovered link is first evaluated through the static article-detail evaluator.

A static detail HTTP 429 is currently considered browser-recoverable. The worker may therefore launch Playwright against the same URL immediately after the publisher has already returned 429.

This is incorrect. HTTP 429 is an explicit host-level throttling signal, not a browser-rendering failure.

Primary files to inspect

- `server/utils/news-pipeline/article-discovery-headless-queue.ts`
- `server/utils/news-pipeline/article-discovery-headless-queue-browser.test.ts`
- `server/utils/news-pipeline/agent2-target-lifecycle.ts`
- `server/utils/news-pipeline/agent2-target-lifecycle.test.ts`
- existing host cooldown evidence helpers
- related normalization or health modules only if required

Required implementation

1. Never invoke browser detail recovery after a confirmed static HTTP 429.

Browser detail recovery may remain available for appropriate failures such as:

- HTTP 401 or 403, if existing policy allows it;
- dynamic or empty HTML;
- browser-rendering-specific recovery cases;
- non-rate-limit navigation failures.

HTTP 429 must not be included in that browser-recovery set.

2. Stop processing remaining detail links after the first confirmed static or browser detail 429.

Do not fetch article N+1 after article N returned 429.

3. Activate host-level cooldown immediately.

Use the structured `Retry-After`/retry timestamp introduced by Prompt 1 when available.

Otherwise use the existing bounded Agent 2 browser cooldown policy.

The cooldown must apply to:

- the current target;
- remaining targets on the same normalized host during the current run;
- subsequent queue invocations through persisted evidence.

4. Preserve correct partial-success behavior.

If candidates were accepted and durably persisted before the 429:

- retain those candidates;
- keep the queue artifact retryable;
- keep its state `PENDING_HEADLESS`;
- do not set `resolvedAt`;
- do not emit resolved-success logs;
- do not increment resolved-success counters;
- do not apply hard-source failure side effects.

5. Preserve correct zero-candidate behavior.

If the first evaluated detail URL returns 429:

- retain the retryable artifact;
- persist rate-limit evidence;
- do not classify the target as a permanent browser failure;
- do not create or worsen a hard-source profile.

6. Preserve CAS and persistence boundaries.

Final artifact transitions must continue to verify `updateMany().count`.

If persistence or the final state transition fails or conflicts:

- do not claim the artifact is safely retryable unless `PENDING_HEADLESS` was confirmed;
- suppress success counters and success logs;
- report unknown worker state and recovery requirements accurately.

7. Correct the existing regression test that encodes the wrong behavior.

Any test that expects one Playwright recovery attempt after a static HTTP 429 must be changed.

The correct expectation is zero browser detail recovery calls after a confirmed static 429.

Required regression tests

Add or update tests proving:

1. Static HTTP 429 causes zero browser detail recovery calls.
2. Static HTTP 403 may still use browser recovery.
3. Static HTTP 429 stops remaining link evaluations immediately.
4. Browser HTTP 429 also stops remaining evaluations immediately.
5. Structured retry evidence is preserved in the artifact payload.
6. Same-run targets on the same host are cooldown-skipped.
7. Persisted cooldown evidence affects later queue runs.
8. Partial accepted candidates followed by 429 remain persisted.
9. Partial accepted candidates followed by 429 keep the artifact `PENDING_HEADLESS`.
10. No resolved-success log, counter, `resolvedAt`, or hard-source side effect occurs.
11. A successful retry after cooldown resolves normally.
12. Retry deduplication remains intact.
13. CAS conflict and transition-throw behavior remains audit-accurate.

Validation

Run:

- focused headless queue tests;
- target lifecycle tests;
- host cooldown and normalization tests;
- full Vitest suite;
- `npx nuxt typecheck`;
- `git diff --check`.

Report separately:

- static 429 behavior;
- browser 429 behavior;
- artifact state behavior;
- cooldown persistence;
- test results;
- residual risks.

Safety constraints

- Inspect the current dirty worktree first.
- Preserve Prompt 1 changes.
- Do not redesign static discovery in this task.
- Do not modify Agent 1 or Agent 3.
- Do not access production systems.
- Do not commit or push.