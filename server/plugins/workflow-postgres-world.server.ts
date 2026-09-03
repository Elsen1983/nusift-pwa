/**
 * Starts the durable Workflow SDK worker for a self-hosted deployment.
 * Vercel owns this lifecycle in the serverless world; the Postgres world
 * requires one long-lived application process to subscribe to its queue.
 */
export default defineNitroPlugin(async (nitroApp) => {
  // An explicit deployment marker prevents a Vercel environment variable
  // mistake from ever starting the self-hosted queue consumer on Vercel.
  if (
    process.env.NUSIFT_SELF_HOSTED !== "true"
    || process.env.WORKFLOW_TARGET_WORLD !== "@workflow/world-postgres"
  ) return;

  const { getWorld } = await import("workflow/runtime");
  const world = getWorld() as {
    start?: () => Promise<void>;
    close?: () => Promise<void>;
  };

  await world.start?.();

  nitroApp.hooks.hook("close", async () => {
    await world.close?.();
  });
});
