# Local development runbook

## Normal order

1. Run Agent 1 batches until Agent 1 progress reports no remaining targets.
2. Run Agent 2 static batches until its eligible work is drained.
3. Run Agent 2 headless/browser recovery in Docker when pending markers exist and cooldown permits attempts.
4. Run Agent 3 normal enrichment for newly inserted/unenriched articles.
5. Use Agent 3 browser fallback only for eligible access/structure failures and within small attempt limits.
6. Use include-enriched/force-reprocess only for extractor-version testing, explicit repair, or scoped article/source IDs.
7. Inspect progress, rejection diagnostics, cooldowns, persistence counts, and representative reader modals.

## Graph maintenance

After substantial code changes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev/update-local-knowledge-graph.ps1
```

For architecture work, query first:

```powershell
graphify query "Trace Agent 3 extraction and persistence"
graphify affected "article-content-extractor"
```

## Operational caution

Do not repeatedly override cooldowns or force reprocess the entire corpus to make progress counters fall. Explicit overrides are diagnostic tools and can create publisher load, duplicate work, or misleading run summaries.

#nusift #runbook #local-development
