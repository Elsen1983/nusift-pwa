# Target lifecycle and recovery

## Agent 2 lifecycle

A source/category target can be statically productive, pending browser recovery, processing, cooling down, browser-resolved, unresolved/hard-source, or resolved later by Agent 1 RSS. Lifecycle helpers normalize artifact history into an admin-facing current state.

## Recovery mechanisms

- Compare-and-set queue claims prevent duplicate ownership.
- Stale processing claims can be recovered rather than permanently blocking a target.
- Newer successful static discovery can supersede stale pending browser markers.
- Agent 1 scoped RSS resolution closes obsolete Agent 2 markers and profiles for the exact target.
- Hard-source profiles preserve compact failure evidence and suggested remediation without publisher-specific production branches.
- Activated discovery profiles require explicit lifecycle/audit state and should be reversible.

## Identity rule

Target matching must use normalized target URL plus source/category identity where required. Missing or malformed target identity must not accidentally resolve or cooldown a different target.

## Graphify entry points

- [[Graphify/agent2-target-lifecycle.ts.md|agent2-target-lifecycle.ts]]
- [[Graphify/agent1-rss-cleanup.ts.md|agent1-rss-cleanup.ts]]
- [[Graphify/hard-source-profile.ts.md|hard-source-profile.ts]]
- [[Graphify/headless-queue-normalize.ts.md|headless-queue-normalize.ts]]

#nusift #lifecycle #recovery #state-machine
