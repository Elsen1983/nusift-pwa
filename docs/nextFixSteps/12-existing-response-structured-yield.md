# Repair 12: Existing-Response Structured Yield

## Objective

Increase Agent 2 discovery and Agent 3 body yield from HTML already fetched by the static pipeline, without adding publisher requests or broadening browser eligibility.

## Verified baseline

- Agent 3 already extracts trusted `Article`/`NewsArticle` JSON-LD `articleBody`, but only when DOM/readability output is absent or unusable.
- Agent 2 already extracts direct article-like JSON-LD objects from the first listing page.
- Feed discovery already reads bounded inline taxonomy evidence, including some Next.js/WordPress-shaped data.
- This repair must extend these authorities, not create parallel parsers.

## Scope

Primary areas:

- shared bounded JSON/JSON-LD traversal helpers
- Agent 2 first-page `ItemList` and `__NEXT_DATA__` article-link extraction
- Agent 3 candidate comparison between weak DOM/readability and trusted JSON-LD `articleBody`
- extraction/discovery diagnostics and focused fixtures

Do not add network requests, WordPress API calls, AMP fetches, browser fallback, schema changes, identity changes, publication changes, or access-taxonomy changes.

## Required behavior

1. Parse only bounded script blocks from the already-received HTML. Never execute script text.
2. Extend the existing JSON-LD traversal to extract article URLs from properly scoped `ItemList.itemListElement` entries.
3. Extract article candidates from bounded, recognized `__NEXT_DATA__` shapes only when URL/title/date evidence is sufficient.
4. Apply existing URL policy, verified-host scope, category scope, freshness, dedupe, SSRF-independent URL validation, and evaluation caps to every structured candidate.
5. Structured URLs do not bypass Prompt 15 request budgets. They only improve which URLs receive the existing bounded evaluation slots.
6. Agent 3 must compare trusted JSON-LD body and DOM/readability body using one pure quality decision. Prefer JSON-LD only when it is demonstrably more complete than a weak DOM result; preserve stronger DOM content.
7. Reject `description`, teaser, navigation, `WebPage`, `CollectionPage`, malformed graph, and unrelated `ItemList` content as complete article bodies.
8. Bound script bytes, object count, traversal depth, array length, candidate count, and diagnostic samples.
9. Persist only bounded source/type/count evidence, never full script JSON or body duplication.

## Tests

Cover:

- JSON-LD body beats a short/truncated DOM body;
- strong DOM body remains preferred over shorter JSON-LD;
- valid `ItemList` yields scoped article URLs;
- breadcrumb/navigation/product ItemLists are rejected;
- supported `__NEXT_DATA__` article list yields candidates;
- malformed, oversized, deeply nested, and cyclic mock structures stop boundedly;
- external/category-mismatched URLs are rejected;
- duplicates across anchor/JSON-LD/NextData consume one evaluation slot;
- no additional transport call occurs;
- access/paywall and publication behavior remain unchanged.

## Acceptance criteria

- Existing HTML produces more valid candidates/content without extra requests.
- One shared bounded structured-data authority is used.
- Strong existing DOM extraction is not regressed.
- Structured evidence cannot bypass URL, freshness, identity, request-budget, or persistence rules.
- Focused tests, Nuxt typecheck, and `git diff --check` pass.

## Safety and validation budget

- No live publisher calls, production access, migration, commit, or push.
- Use local fixtures and affected discovery/extractor tests only.
- Do not repeatedly run the full suite.

## Completion response

Report supported structured shapes, selection/scoring rules, parser bounds, added-request count, test results, and unsupported framework payloads.
