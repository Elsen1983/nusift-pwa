# Local Obsidian and Graphify setup

This repository uses Obsidian and Graphify only as local development tools. They are not production dependencies and are not used by Vercel builds or runtime code.

## Installed tools

- Obsidian: native Windows desktop application.
- Graphify: isolated `uv tool` installation from the official `graphifyy` PyPI package.
- Codex integration: installed in the user-level Codex skills directory.

The project `docs/` directory is the Obsidian vault. Generated Graphify files remain local:

- `graphify-out/`: machine-readable graph, report, and visualization.
- `docs/Graphify/`: Obsidian notes generated from the graph.
- `docs/.obsidian/`: local vault settings.

All three paths are ignored by Git.

## First use

Restart the terminal or Codex after the initial installation so the updated user `PATH` and Graphify skill are loaded.

Open Obsidian and choose **Open folder as vault**, then select:

```text
E:\Study\AI\NuSift\nusift-app\docs
```

Keep Restricted Mode enabled initially. The NuSift vault does not require community plugins; built-in Backlinks, Graph view, Search, Tags, and Properties are sufficient.

## Build and update the graph

Graphify Git hooks are installed locally for this checkout. They refresh the structural code graph after commits and branch switches without adding a production or CI dependency. Repository-level agent instructions also tell Codex to query the graph first for architecture and impact-analysis work.

Run a free, local, deterministic code-only extraction from the repository root:

```powershell
graphify extract . --code-only --max-workers 4
```

Update the graph after code changes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev/update-local-knowledge-graph.ps1
```

The wrapper resolves Graphify even when a GUI or Codex process has a stale `PATH`, then updates the graph, exports it into the Obsidian vault, and fixes Canvas paths. Graphify writes Canvas file references relative to its export directory, while the Obsidian vault root is `docs/`; without the path fix, Obsidian displays `Create new note` even though the generated note already exists.

The Git hook updates the structural graph in the background. After a substantial code change, Codex should also run the Obsidian export so the generated vault notes remain synchronized.

Inside a new Codex task, the installed skill also supports:

```text
/graphify .
/graphify . --update
```

Use `--mode deep` only when semantic analysis is intentionally configured. The normal local workflow uses `--code-only`, which requires no API key and sends no source code to an external model.

## Useful queries

```powershell
graphify query "How does Agent 3 persist article body text?"
graphify explain "runEnrichmentBatch"
graphify affected "article-content-extractor"
graphify god-nodes --top 15
```

Open the standalone interactive visualization at `graphify-out/graph.html` when a visual architecture overview is more useful than Obsidian notes.

## Maintenance

Upgrade Graphify:

```powershell
uv tool upgrade graphifyy
graphify install --platform codex
```

Obsidian updates itself on restart. Periodically install the latest official Windows installer as well so the bundled Electron runtime receives security updates.

Rebuild from scratch only when the graph becomes inconsistent:

```powershell
graphify extract . --code-only --force --max-workers 4
graphify export obsidian --dir docs/Graphify
powershell -ExecutionPolicy Bypass -File scripts/dev/fix-graphify-obsidian-paths.ps1
```

Do not add Graphify, Obsidian, Python, or `uv` to `package.json`, Docker images, Vercel configuration, or production environment variables.
