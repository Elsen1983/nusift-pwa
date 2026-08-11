# Testing and safety invariants

## Required evidence

- Pure policy/helper tests for deterministic classification.
- Real integration-path tests proving Agent 1/2 callers apply shared policies.
- Persistence tests proving fields, artifacts, and run summaries match outcomes.
- Race/cooldown tests for atomic claims, deferral, and bounded attempt counts.
- Endpoint tests for authorization, parameter clamping, and response semantics.
- Browser or screenshot verification for significant admin/mobile UI changes.

## Cross-stage invariants

- No publisher-specific special casing unless explicitly approved and represented as data/profile configuration.
- No production-only business logic divergence from local paths.
- No success logging before durable writes complete.
- Known stale dates cannot bypass the retention hard cap.
- HTTP access blocks are not mislabeled as paywalls or unsupported DOM structure.
- Shadow URL policy decisions never block production candidates.
- Unknown artifact states are cleaned conservatively.
- Existing user work and unrelated dirty-worktree changes must not be reverted.

## Validation order

1. Targeted tests for changed behavior.
2. Typecheck.
3. Broader related suites.
4. Full suite when feasible, documenting verified pre-existing failures separately.
5. Runtime/browser verification where static checks cannot prove behavior.

#nusift #testing #safety #invariants
