# Maintenance and cleanup

## Article cleanup

Old articles outside the retention window are eligible only when no supported user-owned relation protects them. Cleanup is batched, dry-run by default on admin surfaces, and production deletion requires explicit authorization/configuration.

## Artifact cleanup

Artifact cleanup removes aged terminal or reviewed diagnostic history conservatively. Active queue markers, in-flight processing, unresolved hard-source state, and unknown status/type combinations remain protected unless a newer durable success safely supersedes them.

## Cron runner

The maintenance runner processes repeated bounded batches under a wall-clock budget. It stops on completion, time budget, no progress, or error and reports phase-specific stop reasons.

## Graphify entry points

- [[Graphify/processOldArticleRetentionCleanup().md|processOldArticleRetentionCleanup]]
- [[Graphify/processPipelineArtifactCleanup().md|processPipelineArtifactCleanup]]
- [[Graphify/runMaintenanceCleanup().md|runMaintenanceCleanup]]
- [[Graphify/pipeline-artifact-cleanup.ts.md|pipeline-artifact-cleanup.ts]]

#nusift #maintenance #cleanup #retention
