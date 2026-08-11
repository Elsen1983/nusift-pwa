# Agent 3 HTTP Transport Policy

Agent 3 uses HTTPS-first transport for article URLs that arrive as `http://`.
The HTTPS attempt is a normal governed request. If it fails, an HTTP retry is
permitted only for hosts listed in `NUSIFT_AGENT3_HTTP_FALLBACK_ALLOWED_HOSTS`.

The environment variable is a comma-separated hostname allowlist, for example:

```text
NUSIFT_AGENT3_HTTP_FALLBACK_ALLOWED_HOSTS=legacy.example.com
```

The fallback is public-read-only transport: the extractor sends no cookies,
authorization headers, or user data. Both HTTPS and HTTP attempts pass through
the SSRF guard and Domain Governor independently.

When HTTPS succeeds, the Article canonical URL is promoted from HTTP to the
HTTPS equivalent in the same claim-guarded Agent 3 persistence transaction.
The original HTTP URL remains in bounded enrichment provenance. HTTP and HTTPS
scheme variants share the same Agent 1 candidate identity, preventing duplicate
Article rows.

The allowlist is intentionally empty by default. Adding a host is an explicit
operator decision for a public source that has a useful HTTP-only fallback;
publisher-specific exceptions must not be hardcoded into pipeline logic.
