# NuSift local knowledge graph workflow

Graphify and Obsidian are local development tools only. Never add them to production dependencies, Docker images, Vercel configuration, CI requirements, or runtime code.

When `graphify-out/graph.json` exists and the task concerns NuSift architecture, control flow, file relationships, impact analysis, or project content:

1. Query the existing Graphify graph before broad source exploration.
2. Use focused `graphify query`, `graphify explain`, `graphify path`, or `graphify affected` commands.
3. Treat graph results as navigation evidence, then verify important conclusions in the current source code and tests.
4. Do not rebuild the full graph for an ordinary question.

After a substantial code change or a completed development batch, refresh the local outputs:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev/update-local-knowledge-graph.ps1
```

The wrapper resolves Graphify from `PATH`, the user-local launcher, or the isolated `uv tool` installation, then runs the graph update, Obsidian export, and canvas path fix in order. The installed local Git hooks refresh the structural graph after commits and branch switches; the wrapper also keeps the `docs/Graphify/` view synchronized after substantial changes.

Generated Graphify and Obsidian state is Git-ignored. If Graphify is unavailable or its graph is stale or incomplete, fall back to targeted `rg` searches and direct source inspection rather than trusting stale graph data.
