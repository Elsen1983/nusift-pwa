# Orchestration and cron

## Execution model

Pipeline stages are bounded and independently invokable. Agent 1 completion gates ordinary Agent 2 progression, while Agent 3 consumes article rows produced by either upstream path.

## Surfaces

- Admin/dev endpoints support manual inspection and bounded execution.
- Internal endpoints authenticate with `CRON_SECRET` or the configured fallback secret.
- `vercel.json` schedules production invocations.
- The daily workflow coordinates durable stage execution and heartbeat/progress state.
- Browser-dependent local runs use Docker wrappers for closer runtime parity.

## Safety properties

- Target count and wall-clock budgets prevent unbounded serverless work.
- Deferred work remains durable for later invocations.
- Stage summaries distinguish processed, remaining, failed, blocked, and completed work.
- Internal cron endpoints must not depend on an admin browser session.
- A downstream stage must not infer upstream completion solely from one batch's local `remaining` field.

## Graphify entry points

- [[Graphify/daily-news-pipeline.ts.md|daily-news-pipeline.ts]]
- [[Graphify/heartbeatOrchestration().md|heartbeatOrchestration]]
- [[Graphify/run-agent1.get.ts.md|run-agent1 endpoint]]
- [[Graphify/run-agent3.post.ts.md|run-agent3 endpoint]]

#nusift #orchestration #cron #vercel
