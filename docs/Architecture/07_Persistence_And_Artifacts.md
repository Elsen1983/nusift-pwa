# Persistence and artifacts

## Source of truth

- `Article` stores discovered content references and enrichment state/body data.
- Source/category models store activation, scope, and feed configuration.
- `PipelineRun` records stage-level execution state and compact summaries.
- `PipelineArtifact` stores bounded audit evidence, queue markers, rejections, profiles, and lifecycle transitions.

## Persistence rule

A network or browser result is not considered complete until required database writes succeed. Candidate counts, marker transitions, logs, and run summaries must not claim a stronger success state than durable persistence supports.

## Artifact responsibilities

- Explain why a target/article was accepted, rejected, deferred, blocked, retried, or resolved.
- Carry enough structured metadata for admin normalization without storing full HTML.
- Support queue claiming and recovery through explicit statuses.
- Preserve historical evidence while maintenance removes safe, aged diagnostics.

## Graphify entry points

- [[Graphify/PipelineArtifact.md|PipelineArtifact]]
- [[Graphify/artifacts.ts.md|artifacts.ts]]
- [[Graphify/createPipelineRun().md|createPipelineRun]]
- [[Graphify/prisma.ts.md|Prisma client]]

#nusift #persistence #artifacts #database
