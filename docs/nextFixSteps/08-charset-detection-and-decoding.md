# Repair 08: Charset Detection and Safe Decoding

## Objective

Decode publisher responses using bounded, standards-aware charset handling before HTML/XML parsing so valid non-UTF-8 feeds and articles are not corrupted or rejected.

## Scope

Primary areas:

- governed static response body reading
- Agent 1 RSS/Atom/XML parsing
- Agent 2 listing, sitemap, and static article parsing
- Agent 3 static article extraction
- browser response handling only where the browser does not already provide decoded DOM text
- focused byte-fixture tests

Do not change Unicode paragraph quality rules, article deduplication, canonical URL identity, feed productivity state, governor decisions, robots decisions, or access/paywall classification semantics.

## Decoding authority

Create one shared decoder for bounded response bytes. Do not add separate Agent 1/2/3 charset implementations.

The decoder must apply a documented precedence, such as:

1. validated BOM;
2. supported HTTP `Content-Type` charset;
3. bounded XML declaration for XML feeds/sitemaps;
4. bounded early HTML `<meta charset>` or `http-equiv` declaration;
5. UTF-8 default with explicit replacement/error evidence.

Resolve conflicts conservatively and record only bounded non-sensitive diagnostics.

## Required behavior

1. Read response bodies as bounded bytes before decoding when the transport permits it.
2. Support at least UTF-8/UTF-16 BOMs, ISO-8859-1/Windows-1252, and the currently required Central/Eastern European legacy encodings supported by the selected maintained library/runtime.
3. Reject unsupported, malformed, or suspicious charset labels without unbounded guessing.
4. Never re-decode browser-provided Unicode DOM text.
5. Preserve body size, request budget, timeout, SSRF, robots, and Domain Governor boundaries.
6. Decompression remains the HTTP client's responsibility; do not decode compressed bytes as text.
7. Decoding failure must be a truthful technical extraction/feed failure, not paywall, 403, 429, or publisher hard-source evidence.
8. Never persist raw response bytes or unbounded HTML/XML as diagnostics.
9. Normalize resulting text to NFC only after correct decoding and before hashing/extraction where the existing identity contract requires it.
10. Do not silently change canonical URL or dedupe semantics in this repair.

## Tests

Use local byte fixtures, not live publishers. Cover:

- UTF-8 with and without BOM;
- UTF-16 XML declaration/BOM;
- Windows-1252 and ISO-8859-1 accented text;
- a Central/Eastern European legacy encoding required by current sources;
- HTTP header versus HTML/XML declaration precedence;
- malformed and unsupported charset labels;
- declaration outside the bounded sniff window;
- invalid byte sequence and replacement diagnostics;
- exact byte/body limits;
- RSS title/body, sitemap URL, listing title, and Agent 3 article body paths;
- no raw bytes or content leakage in logs/artifacts.

## Dependency and bundle constraints

- Prefer platform APIs or a small maintained decoder already present in the dependency graph.
- If adding a package, document server bundle impact and confirm compatibility with Node/Vercel.
- Do not add native binaries or browser-only decoders to server runtime.

## Acceptance criteria

- Supported legacy feeds/pages decode correctly through the real parser path.
- UTF-8 behavior remains unchanged.
- Unsupported input fails boundedly and truthfully.
- One decoder authority is used by all relevant static stages.
- Focused tests, Nuxt typecheck, production build if dependencies change, and `git diff --check` pass.

## Safety and validation budget

- No live publisher requests, production access, migration, commit, or push.
- Run only decoder and affected parser/extractor tests during implementation.
- Do not run the full suite repeatedly.

## Completion response

Report supported encodings, precedence matrix, byte/sniff limits, integration points, bundle impact, tests run, and unsupported cases.
