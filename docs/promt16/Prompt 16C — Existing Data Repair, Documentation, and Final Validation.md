Prompt 16C — Existing Data Repair, Documentation, and Final Validation

Prerequisite
------------

Prompts 16A and 16B must already be implemented, reviewed, and passing.

Objective
---------

Provide a safe, auditable way to identify and repair existing false-positive paywall records, update the stale documentation, and complete final end-to-end validation.

Do not execute any production repair.

Required implementation
-----------------------

1. Add a bounded paywall audit/repair utility.

Create a maintained script or admin-only service that scans existing articles with:

- isPaywall=true;
- a coherent successful or supported partial Agent 3 outcome with substantial stored body text and valid current access evidence; supported durable combinations are `SUCCESS + ENRICHED` and `LOW_CONTENT_QUALITY + ENRICHMENT_FAILED` with substantial usable body text;
- substantial stored body text;
- existing enrichment outcome/artifact evidence.

The utility must use the new classifier and must not apply ad hoc regex replacements.

2. Dry-run must be the default.

Default behavior:

- read-only;
- bounded scan;
- deterministic ordering;
- no Article updates;
- no artifact writes;
- no publication-state changes.

Dry-run output must include:

- inspected count;
- likely false positives;
- confirmed blocking paywalls;
- declared/metered cases;
- unknown cases;
- skipped cases;
- access detector-version mismatch count;
- per-source bounded summary;
- sanitized samples;
- proposed old -> new classification;
- proposed old -> new isPaywall value;
- evidence codes;
- reason for no change.

3. Add explicit apply safeguards.

Apply mode must require:

- explicit apply flag;
- exact confirmation token;
- bounded batch limit;
- local/development database by default;
- environment guard;
- transaction-safe per-article update;
- idempotency;
- an audit artifact for every applied change.

Suggested token:

APPLY_PAYWALL_CLASSIFICATION_REPAIR

Production mode must require a separate, explicit production confirmation token and environment opt-in. Implement the guard, but do not run it.

Never infer production access from a commented `.env` value.

4. Only repair high-confidence cases automatically.

Automatic true -> false repair requires all of:

- substantial usable stored body;
- a coherent successful or supported partial Agent 3 outcome with substantial stored body text and valid current access evidence;
- supported durable combinations: `SUCCESS + ENRICHED` or `LOW_CONTENT_QUALITY + ENRICHMENT_FAILED` with substantial usable body text;
- no article-scoped gate;
- no confirmed PAYWALL_BLOCKED evidence;
- new classifier returns ACCESSIBLE with high confidence;
- no unresolved conflicting newer artifact;
- current Article row still matches the inspected state.

Do not automatically modify:

- `PAYWALL_BLOCKED` lifecycle outcomes; they fail closed and are not automatically rewritten;
- UNKNOWN cases;
- short-preview cases;
- unresolved HTTP blocks;
- interstitial/challenge cases;
- conflicting artifact histories;
- genuine PAYWALL_BLOCKED cases;
- records with missing or malformed evidence.

5. Preserve publication behavior.

Changing an incorrect `isPaywall` value must not automatically publish, reject, delete, or re-enrich an article.

The repair may update only `Article.isPaywall`, bounded `enrichmentOutcome.access`, bounded `paywallRepair` metadata, and `updatedAt` through the normal database update, plus one bounded `paywall_classification_repair` artifact. It must preserve outcome kind, enrichment status, publication status, body text, and publication fields; it must not publish, reject, delete, or automatically re-enrich the article.

Do not alter publicationStatus unless a separate existing canonical publication gate requires it and the behavior is explicitly proven by tests.

6. Detector versioning and reprocessing.

Introduce or bump the maintained article-access detector version.

New Agent 3 runs must record `ARTICLE_ACCESS_DETECTOR_VERSION` under access evidence. `extractorVersion` and access `detectorVersion` are separate version domains; never copy the detector version into `extractorVersion`.

Provide bounded diagnostics for articles evaluated with an older detector.

Do not automatically force-reprocess the entire Article table.

If existing Agent 3 extractor-version logic can safely schedule affected records, document the exact bounded mechanism. Otherwise keep re-evaluation as an explicit repair operation.

7. Update documentation.

Update:

docs/reportAboutPaywall.md

The document is currently stale and contains obsolete claims that Agent 1 and Agent 2 still use `/paywall|subscribe|premium/` over whole documents.

Rewrite it to reflect the current implementation:

- centralized early-stage detector;
- Agent 1 and Agent 2 hint responsibilities;
- Agent 3 authoritative classification;
- removal of generic `/paywall/i` as decisive evidence;
- separate technical access states;
- structured JSON-LD scoping;
- full-body contradiction;
- final boolean compatibility mapping;
- diagnostics and access detector version, kept separate from Agent 3 extractor versioning;
- repair workflow;
- known limitations.

Correct the file encoding if it currently contains mojibake, while preserving meaningful content.

8. Add repair tests.

Cover:

A. Dry-run performs no writes.

B. Apply without token is rejected.

C. Incorrect token is rejected.

D. Production-like environment without explicit production opt-in is rejected.

E. High-confidence accessible false positive changes true -> false.

F. Genuine paywall remains true.

G. Unknown/conflicting case is skipped.

H. Concurrently changed Article fails closed.

I. Repeated apply is idempotent.

J. Applied change creates one bounded audit artifact.

K. Sensitive URLs/evidence are sanitized.

L. Batch limit and deterministic ordering are enforced.

M. The Bytepoint-style regression fixture is proposed for repair without publisher-specific logic.

9. Final validation.

Run:

- all paywall classifier tests;
- Agent 1 tests;
- Agent 2 tests;
- Agent 3 extractor/runtime/persistence tests;
- repair tests;
- feed API tests;
- admin diagnostics tests;
- full Vitest suite;
- Nuxt typecheck;
- Prisma validate;
- Prisma generate if required by the repository;
- git diff --check;
- production build;
- workflow bundle guard.

Inspect git status and ensure:

- no dumps;
- no `.env` files;
- no secrets;
- no generated browser artifacts;
- no temporary database files;
- no unrelated files are included.

Constraints
-----------

- Do not execute production repair.
- Do not access production DB/API/Vercel/secrets.
- Do not change Prisma schema or migrations.
- Preserve unrelated worktree changes.
- Preserve Prompt 14 and Prompt 15A/15B behavior.
- Do not commit or push.

Final report
------------

Report:

1. audit/repair entry point;
2. exact dry-run command;
3. exact local apply command;
4. production guard behavior without executing it;
5. automatic repair criteria;
6. skipped/conflicting criteria;
7. idempotency and artifact behavior;
8. access detector versioning, kept separate from Agent 3 extractor versioning;
9. documentation changes;
10. before/after fixture counts;
11. complete validation results;
12. schema status;
13. production-access status;
14. git status and confirmation that no commit or push occurred.