Prompt 15A - Static Agent 2 Request Budget and 429 Handling

Audit and implement the static Agent 2 discovery request-budget and HTTP 429 correction.

This task is limited to the static Agent 2 discovery path. Do not modify the headless/browser queue implementation yet; that will be handled separately.

Verified problems

1. `MAX_TOTAL_CANDIDATES` limits accepted candidates, not evaluated URLs.
2. A target with many rejected links can therefore cause approximately 100 or more article-detail requests.
3. Listing discovery and sitemap discovery currently start together through `Promise.all()`.
4. Sitemap probing can consume multiple requests even when the listing page already exposes enough strong article links.
5. Static article-detail HTTP 429 responses are represented only as generic `fetch_failed` outcomes.
6. Static detail-level 429 responses are not included in the same rate-limit telemetry path as listing-level 429 responses.
7. Partial accepted candidates followed by a 429 must not make the target appear fully completed.

Primary files to inspect

- `server/utils/news-pipeline/article-discovery.ts`
- `server/utils/news-pipeline/article-discovery-helpers.ts`
- `server/utils/news-pipeline/article-discovery.test.ts`
- relevant discovery types and telemetry modules, only if required

Required implementation

1. Add an explicit static evaluation cap independent from the accepted-candidate cap.

Use clearly separated concepts, for example:

- `MAX_ACCEPTED_CANDIDATES`
- `MAX_EVALUATED_CANDIDATES`

The evaluated limit must count every article-detail evaluation attempt, including accepted, rejected, failed, stale, duplicate, and rate-limited outcomes.

Choose a conservative default such as 30 unless existing configuration or documented requirements justify a different value.

2. Add a bounded per-target network request budget.

The budget must cover:

- listing-page fetches;
- robots.txt;
- sitemap fetches;
- sitemap-index child fetches;
- article-detail fetches.

Do not silently exceed the budget. When exhausted, return explicit bounded diagnostic evidence instead of pretending discovery completed normally.

Redirect hops may remain one logical request if this matches the existing telemetry definition, but document and test that semantic.

3. Remove unconditional parallel listing and sitemap discovery.

Use a staged strategy:

- fetch and inspect listing pages first;
- determine whether the listing produced enough viable article links;
- only run sitemap discovery when listing evidence is insufficient.

Define “sufficient” deterministically and test it. Do not base the decision solely on accepted candidates because detail evaluation has not happened yet.

Preserve sitemap fallback for sparse, empty, blocked, or structurally weak listing pages.

4. Represent HTTP 429 as structured evidence.

Do not depend solely on string matching such as `"HTTP 429"`.

Preserve at least:

- HTTP status;
- rate-limited classification;
- parsed `Retry-After` when valid;
- bounded retry timestamp;
- source phase, such as listing, sitemap, or article detail.

Handle both delta-seconds and HTTP-date `Retry-After` formats. Clamp untrusted or extreme values to a safe configured range.

5. Stop static detail evaluation immediately after the first confirmed 429 from the target host.

Do not continue with later article URLs.

Preserve candidates accepted before the 429, but mark discovery as incomplete and retryable.

6. Ensure partial success is not reported as complete success.

If accepted candidates exist before a 429:

- preserve and persist those candidates;
- record that detail evaluation stopped because of rate limiting;
- do not resolve stale retry/headless markers as though the complete shortlist was processed;
- preserve a retryable artifact/state with the calculated cooldown.

If no candidates were accepted, the outcome must still be classified as rate-limited/deferred rather than a permanent discovery failure.

7. Record detail-level 429 telemetry.

The batch telemetry must count confirmed detail-level 429 responses, not only listing diagnostics.

Avoid double-counting one response through multiple layers.

8. Preserve existing safety and data-quality behavior.

Do not weaken:

- SSRF protection;
- canonical-host verification;
- category-path filtering;
- freshness enforcement;
- URL policy;
- candidate deduplication;
- persistence-before-resolution ordering;
- Agent 1 or Agent 3 behavior.

Required regression tests

Add tests proving:

1. Evaluated URLs stop at the configured evaluation cap even when every URL is rejected.
2. Accepted-candidate and evaluated-candidate limits are independent.
3. A strong listing avoids unnecessary sitemap requests.
4. A sparse listing still uses sitemap fallback.
5. The total logical request budget cannot be exceeded.
6. The first detail HTTP 429 stops further detail fetches.
7. A detail 429 records rate-limit telemetry exactly once.
8. `Retry-After` delta-seconds is parsed and bounded.
9. `Retry-After` HTTP-date is parsed and bounded.
10. Missing or invalid `Retry-After` uses the configured fallback cooldown.
11. Partial accepted candidates survive a later 429.
12. Partial accepted candidates followed by 429 do not resolve the target as fully complete.
13. A zero-candidate 429 is deferred/retryable, not treated as a hard-source failure.
14. Non-429 failures continue to follow existing behavior.

Validation

Run:

- focused static Agent 2 discovery tests;
- all directly affected telemetry/artifact tests;
- full Vitest suite;
- `npx nuxt typecheck`;
- `git diff --check`.

Report separately:

- implemented behavior;
- tests added;
- focused validation;
- full validation;
- residual risks.

Safety constraints

- Inspect the current dirty worktree before editing.
- Preserve unrelated changes.
- Do not rewrite existing migrations.
- Do not access or modify production databases.
- Do not commit or push.
- Do not modify the headless queue or browser lifecycle in this task.

Response 1

Elkészült és validálva a Prompt 15A statikus Agent 2 része. A dirty worktree-ben lévő korábbi, headless/browser és egyéb módosításokat nem állítottam vissza és nem commitoltam.
Implementált viselkedés
- Külön  MAX_ACCEPTED_CANDIDATES  és  MAX_EVALUATED_CANDIDATES  limitek.
- Célonkénti logikai request budget:
- listing;
-  robots.txt ;
- sitemapek és sitemap-index gyermekek;
- article-detail kérések.
- Listing-first stratégia; sitemap csak determinisztikusan elégtelen listing esetén indul.
- HTTP 429 strukturált bizonyítékkal:
- fázis;
- status;
-  Retry-After  forrás;
- bounded retry timestamp.
-  Retry-After  támogatás:
- delta-seconds;
- HTTP-date;
- fallback és biztonságos clamp.
- Az első detail-szintű 429 azonnal leállítja a további detail evaluationt.
- Részleges accepted candidate-ek megmaradnak és persistálódnak.
- Rate-limited/incomplete discovery nem old fel stale headless markereket, és retryable artifactként marad.
- Listing-level 429 után nem indul további sitemap probing.
- A request budget exact-boundary állapota nem minősül automatikusan hiányos futásnak; csak ténylegesen elutasított következő request állítja exhausted állapotra.
- Robusztus header-olvasás natív és mock header objektumokhoz is.
Tesztek
Bővítve/javítva a statikus discovery és helper regressziós tesztkészlet:
- evaluated vs accepted cap;
- listing/sitemap fallback;
- teljes request budget;
- detail/listing/sitemap 429;
- első 429 utáni leállás;
- részleges siker;
- retry telemetry;
- delta-seconds, HTTP-date és fallback  Retry-After ;
- non-429 regressziók.
Validáció
- Fókusztesztek: 179/179 passed
- Közvetlenül érintett suite: 403/403 passed
- Teljes Vitest: 2681 passed, 5 skipped
-  npx nuxt typecheck : sikeres
-  git diff --check : sikeres
Megjegyzés: a Windows tool runner minden futás végén jelzett egy környezeti  taskkill.exe   ENOENT  cleanup warningot; ez nem okozott projekt- vagy teszthibát.

-----------------
Prompt 2

Correct the remaining static Agent 2 request-budget and lifecycle defects found after reviewing the Prompt 15A implementation.

Do not start Prompt 15B and do not modify browser-detail recovery behavior in this task.

The existing Prompt 15A implementation must be preserved where correct:

- separate accepted and evaluated limits;
- listing-first discovery;
- structured HTTP 429 evidence;
- bounded Retry-After parsing;
- request-budget accounting;
- persistence-before-marker-resolution ordering;
- partial candidate preservation.

Confirmed remaining defects

1. `evaluation_cap` currently produces `retryable=true` and
   `discoveryComplete=false`, but there is no durable continuation cursor.

A later run starts from the same ordered link set and may evaluate the same
first N URLs indefinitely. This is not forward progress.

2. A retryable or rate-limited static result only creates a headless queue
   marker when `qualityAssessment.shouldEscalateToHeadless` is true.

A partial result may be classified as quality `productive` even though it is
rate-limited and incomplete. Such a result can therefore remain retryable
without entering the queue that will handle its cooldown/retry.

3. Downstream Agent 2 health and hard-source aggregation can interpret an
   artifact as productive solely from `qualityAssessment.quality`, even when:

- `retryable === true`;
- `discoveryComplete === false`;
- `detailEvaluationStoppedReason === "rate_limited"`.

4. When a sparse listing consumes the final available request slot, sitemap
   fallback is skipped because `remaining === 0`. However, the budget is not
   marked exhausted unless another request is actively refused.

The run can therefore be reported complete even though a known required
fallback phase was skipped due to the request budget.

5. Listing pagination can continue after a confirmed listing-page HTTP 429
   because the non-OK response branch uses `continue`.

6. Plain-object response-header lookup is not fully case-insensitive.

Primary files

- `server/utils/news-pipeline/article-discovery.ts`
- `server/utils/news-pipeline/article-discovery-helpers.ts`
- `server/utils/news-pipeline/article-discovery.test.ts`
- `server/utils/news-pipeline/article-discovery-helpers.test.ts`
- `server/utils/news-pipeline/agent2-health.ts`
- `server/utils/news-pipeline/agent2-health.test.ts`
- `server/utils/news-pipeline/hard-source-tracking.ts`
- `server/utils/news-pipeline/hard-source-tracking.test.ts`

Required corrections

1. Define explicit evaluation-cap semantics.

Use the recommended bounded-completion model:

- reaching `MAX_EVALUATED_CANDIDATES` without HTTP 429 or a refused network
  request is an intentional bounded completion;
- preserve `detailEvaluationStoppedReason = "evaluation_cap"` for diagnostics;
- set `discoveryComplete = true`;
- do not set `retryable=true` solely because the evaluation cap was reached.

This avoids an infinite retry loop without introducing a continuation cursor.

If you reject this model, implement a real durable continuation cursor and
prove forward progress across runs. Do not retain retryable evaluation-cap
behavior without continuation.

2. Keep HTTP 429 and actual request-budget exhaustion incomplete and retryable.

The following must remain:

- HTTP 429: incomplete and retryable;
- a request refused because the budget is exhausted: incomplete and retryable;
- a known required discovery phase skipped because no budget remains:
  incomplete and retryable.

3. Add an explicit budget-incomplete operation.

Do not fabricate an extra network request just to mark the budget exhausted.

The budget API should support recording that known work was skipped because no
request slot remained, for example:

- sitemap fallback required but no budget remained;
- another listing page was queued but no budget remained;
- another detail candidate remained but no budget remained.

Keep the existing exact-boundary rule only when no known work remains.

4. Stop listing crawling immediately after the first confirmed listing HTTP 429.

After recording structured evidence and telemetry:

- do not process queued pagination pages;
- do not start robots or sitemap discovery;
- do not evaluate article-detail URLs;
- return a retryable incomplete result.

5. Ensure every retryable static result creates or preserves the appropriate
headless queue marker.

Queue creation must occur when either:

- quality assessment requests escalation; or
- `result.retryable === true`;
- `result.discoveryComplete === false` due to HTTP 429 or request-budget
  exhaustion.

The queue marker payload must include bounded structured evidence needed by
Prompt 15B:

- target URL;
- stop reason;
- rate-limit phase;
- retry timestamp;
- Retry-After source;
- request-budget snapshot;
- discovery completeness;
- accepted/evaluated counts.

Do not duplicate markers. Preserve existing deduplication behavior.

6. Make downstream quality consumers completeness-aware.

Agent 2 health and hard-source tracking must not classify an artifact as a
confirmed productive recovery when:

- `retryable === true`; or
- `discoveryComplete === false`; or
- the stop reason is `rate_limited` or `request_budget_exhausted`.

Such artifacts must also not count as permanent failures or worsen hard-source
failure streaks. Represent them as deferred/incomplete evidence.

Legacy artifacts without the new fields must retain their previous behavior.

7. Make plain-object header lookup genuinely case-insensitive.

Support:

- native `Headers.get()`;
- lowercase object keys;
- canonical keys such as `Retry-After`;
- arbitrary casing such as `RETRY-AFTER`.

Do not expose or persist unrelated response headers.

8. Improve audit status accuracy.

A retryable rate-limit result must not use a success status.

Prefer an explicit deferred/rate-limited audit status if the existing status
vocabulary supports it. Otherwise retain a failure status but ensure the log
clearly says it is transient, incomplete, and retryable.

Required regression tests

Add tests proving:

1. Evaluation-cap completion is bounded and non-retryable.
2. Repeated execution does not claim continuation that does not exist.
3. HTTP 429 remains incomplete and retryable.
4. Actual request-budget exhaustion remains incomplete and retryable.
5. Sparse listing with zero remaining budget is marked incomplete before
   sitemap fallback is skipped.
6. Exact budget boundary remains complete only when no known work remains.
7. Listing page 2 returning 429 prevents listing page 3 from being fetched.
8. Listing 429 prevents robots, sitemap, and detail requests.
9. Partial productive 429 creates or preserves a headless queue marker.
10. Queue marker payload contains structured cooldown evidence.
11. Retryable productive-quality artifacts are not treated as productive
    recovery by Agent 2 health.
12. Retryable productive-quality artifacts neither reset nor increment
    hard-source permanent-failure streaks.
13. Legacy artifacts without Prompt 15A fields preserve previous behavior.
14. `Retry-After`, `retry-after`, and `RETRY-AFTER` plain-object headers parse
    identically.
15. Rate-limit telemetry is still counted exactly once.

Validation

Run:

- static Agent 2 discovery and helper tests;
- Agent 2 health tests;
- hard-source tracking tests;
- artifact and cleanup tests affected by the new statuses;
- full Vitest suite;
- `npx nuxt typecheck`;
- `git diff --check`.

Report separately:

- evaluation-cap semantics;
- request-budget completeness semantics;
- queue-marker behavior;
- downstream health/hard-source behavior;
- focused and full validation;
- residual risks.

Safety constraints

- Inspect the dirty worktree before editing.
- Preserve unrelated Agent 3, paywall, source validation, and browser changes.
- Do not modify Prompt 15B browser recovery behavior.
- Do not change Prisma schema or migrations.
- Do not access production systems.
- Do not commit or push.


-----------
Response 2

Elkészült a Prompt 15A fennmaradó statikus Agent 2 korrekciója.
- Evaluation cap: bounded completionként működik:  discoveryComplete=true ,  retryable=false ,  evaluation_cap  diagnosztikával.
- Request budget: explicit kihagyott munka esetén inkomplett/retryable; a pontos budget-határ önmagában nem hibás állapot.
- 429 kezelés: listing- és detail-szinten strukturált evidence, az első 429 azonnal megállítja a további feldolgozást.
- Queue marker: minden retryable/incomplete batch-eredmény strukturált cooldown-, budget- és számláló-evidence-et kap; a duplikációvédelem megmaradt.
- Downstream health: a retryable/incomplete productive artifact nem számít megerősített recoverynek, és nem növeli/reseteli hibásan a hard-source streaket.
- Header parsing: a  Retry-After ,  retry-after  és  RETRY-AFTER  object kulcsok egységesen működnek.
- Teszt: hozzáadtam az exact-budget-boundary regressziót.
Validáció:
- Fókuszált tesztek: 249 passed
- Teljes Vitest: 130 fájl passed, 2684 teszt passed, 5 skipped
- Nuxt typecheck: sikeres
-  git diff --check : sikeres
- A  taskkill.exe  üzenet Windowsos környezeti cleanup-warning, nem teszthiba.
A meglévő, nem kapcsolódó Agent 3, paywall, source-policy és browser módosításokat megőriztem; commit és push nem történt.

---------------
Prompt 3

Complete the final Prompt 15A static Agent 2 corrections.

Do not begin Prompt 15B and do not modify browser-detail recovery semantics.

Confirmed remaining defects

1. Existing active headless queue markers are returned unchanged by
   `createHeadlessQueueArtifactIfAbsent()`.

When a later static run encounters HTTP 429 or request-budget exhaustion, an
existing `PENDING_HEADLESS` marker therefore does not receive the new:

- retry timestamp;
- rate-limit phase;
- Retry-After source;
- request-budget snapshot;
- completeness state;
- accepted/evaluated counters.

Deduplication prevents duplicate rows correctly, but currently also discards
newer operational evidence.

2. `safeFetchText()` consumes a logical request-budget slot before validating
whether the sitemap URL belongs to the permitted target host.

A robots.txt entry pointing to an external host can therefore consume budget
even though `safeFetch()` is never invoked.

Primary files

- `server/utils/news-pipeline/headless-queue-artifact.ts`
- `server/utils/news-pipeline/headless-queue-artifact.test.ts`
- `server/utils/news-pipeline/article-discovery.ts`
- `server/utils/news-pipeline/article-discovery.test.ts`
- `server/utils/news-pipeline/article-discovery-helpers.ts`
- `server/utils/news-pipeline/article-discovery-helpers.test.ts`

Required correction 1: safely refresh an existing pending marker

When queue creation finds an existing marker:

- preserve deduplication;
- if its status is exactly `PENDING_HEADLESS`, update its static discovery
  evidence using a compare-and-set operation;
- verify `updateMany().count`;
- preserve unrelated existing payload fields;
- preserve `targetKey`;
- do not overwrite browser attempt, claim, processing, or recovery evidence;
- namespace new fields under a bounded `staticDiscovery` object if necessary
  to prevent collisions with browser fields;
- use the latest static retry timestamp and evidence;
- return whether the evidence refresh was confirmed.

Do not mutate markers in:

- `HEADLESS_PROCESSING`;
- `HEADLESS_PROCESSING_STALE`;
- resolved or terminal states.

If the update conflicts because another worker claimed the marker:

- do not claim the marker was refreshed;
- do not overwrite the processing worker;
- keep the separate static discovery artifact as authoritative audit evidence;
- return an explicit conflict result or bounded diagnostic.

Do not introduce a read-modify-write race without a status CAS predicate.

Required correction 2: count only actual logical fetch attempts

In `safeFetchText()`:

1. Parse and validate the URL.
2. Verify the allowed same-publisher/same-domain policy.
3. Only immediately before invoking `safeFetch()`, consume one request-budget
   slot.
4. If no slot remains, record skipped work and do not call `safeFetch()`.

External, invalid, or security-rejected sitemap URLs must:

- not invoke `safeFetch()`;
- not consume request budget;
- not be represented as publisher request failures;
- remain bounded and safely ignored or recorded as non-network rejection
  diagnostics.

Preserve the existing definition that one `safeFetch()` invocation, including
validated redirects, is one logical request.

Required tests

Add regression tests proving:

1. A new retryable result creates one pending marker with structured evidence.
2. A later retryable result does not create a duplicate marker.
3. An existing `PENDING_HEADLESS` marker receives refreshed static cooldown
   evidence.
4. Existing unrelated/browser payload fields are preserved.
5. `targetKey` is preserved.
6. Refresh uses a status CAS and verifies `updateMany().count`.
7. A CAS conflict is reported honestly.
8. `HEADLESS_PROCESSING` is not overwritten.
9. `HEADLESS_PROCESSING_STALE` is not overwritten.
10. Terminal markers are not reused as active markers.
11. A same-host sitemap consumes exactly one budget slot when fetched.
12. A robots.txt external sitemap consumes zero additional budget slots.
13. An invalid sitemap URL consumes zero additional budget slots.
14. `safeFetch()` call count equals the logical request-budget `used` count.
15. Existing exact-boundary, 429, telemetry, and partial-persistence tests
    remain passing.

Validation

Run:

- headless queue artifact tests;
- static discovery helper tests;
- static Agent 2 discovery tests;
- Agent 2 health and hard-source tests;
- full Vitest suite;
- `npx nuxt typecheck`;
- `git diff --check`.

Report separately:

- marker creation behavior;
- existing-marker refresh behavior;
- CAS conflict behavior;
- request-budget accounting;
- focused and full validation;
- residual risks.

Safety constraints

- Preserve all current Prompt 15A behavior.
- Do not implement Prompt 15B browser changes.
- Preserve unrelated dirty-worktree changes.
- Do not modify Prisma schema or migrations.
- Do not access production systems.
- Do not commit or push.

------------
Response 3
Elkészült a Prompt 15A végső statikus Agent 2 korrekciója.
Marker-kezelés
- Az új retryable eredmény továbbra is egyetlen  PENDING_HEADLESS  markert hoz létre.
- Meglévő marker esetén csak az exakt  PENDING_HEADLESS  állapot frissíthető.
- A frissítés státusz-CAS-t ( updateMany ) használ, és csak  count === 1  esetén tekinti sikeresnek.
- CAS-konfliktus esetén nem állítja, hogy a marker frissült.
-  HEADLESS_PROCESSING ,  HEADLESS_PROCESSING_STALE  és terminális állapotok nem módosulnak.
- A browser/claim mezők,  targetKey  és korábbi payload-mezők megmaradnak.
- Az új és frissített marker is tartalmazza:
-  staticDiscovery  namespace-t;
- top-level kompatibilitási aliasokat;
- cooldown-, rate-limit-, budget-, completeness- és accepted/evaluated evidence-et.
- A marker payload allowlistelt és korlátozott méretű; a manuális retry mezők kompatibilisek maradtak.
Request-budget accounting
- A sitemap URL előbb URL-, séma- és host-validáción esik át.
- Csak tényleges  safeFetch()  előtt fogyaszt budget-slotot.
- Külső, hibás vagy nem HTTP(S) sitemap URL nem hív  safeFetch() -et és nem fogyaszt budgetet.
- Megmaradt az egy  safeFetch()  = egy logikai kérés definíció.
- A  Retry-After  header lookup továbbra is case-insensitive.
Validáció
- Fókuszált static discovery/helper/queue/manual-retry tesztek: 198 passed
- Teljes Vitest: 130 fájl passed, 4 skipped; 2691 teszt passed, 5 skipped
- Nuxt typecheck: sikeres
-  git diff --check : sikeres
- A  taskkill.exe   ENOENT  csak ismert Windowsos cleanup-warning, nem teszthiba.
A dirty worktree meglévő, nem kapcsolódó Agent 3, paywall, source-policy és browser módosításait megőriztem. Commit és push nem történt.

----------------
A Prompt 15A most lezárhatónak tekinthető.
Ellenőrizve:
A marker frissítése PENDING_HEADLESS státusz-CAS-t használ: [headless-queue-artifact.ts (line 277)](E:/Study/AI/NuSift/nusift-app/server/utils/news-pipeline/headless-queue-artifact.ts#L277).
count === 1 nélkül nem állít sikeres frissítést.
Processing és stale-processing marker nem módosul.
A payload merge megőrzi a meglévő browser/claim adatokat.
A staticDiscovery evidence korlátozott és allowlistelt.
Az URL-, protokoll- és hostellenőrzés megelőzi a budget fogyasztását: [article-discovery-helpers.ts (line 258)](E:/Study/AI/NuSift/nusift-app/server/utils/news-pipeline/article-discovery-helpers.ts#L258).
Külső vagy hibás sitemap URL nem hív safeFetch()-et.
Az evaluation cap bounded completion marad.
A retryable/incomplete eredmény queue markert hoz létre vagy frissít.
A downstream health és hard-source feldolgozás completeness-aware.
Saját fókuszált futtatás:
5 test files passed
225 tests passed
A diff ellenőrzése is sikeres. Nem találtam új blokkoló correctness hibát. A Prompt 15B elindítható. Ebben a körben nem módosítottam fájlokat.