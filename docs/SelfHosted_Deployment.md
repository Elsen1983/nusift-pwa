# NuSift Self-Hosted Deployment

This deployment replaces the Vercel runtime while preserving the existing Agent 1, Agent 2, Agent 3, durable pipeline, notification workflow, and browser-fallback contracts.

## Services

`postgres` stores NuSift application data. Its named volume is the only durable application data in this Compose stack.

`bootstrap` runs Prisma migrations and the Workflow Postgres schema bootstrap once before the application starts. It must succeed before `app` starts.

`app` serves Nuxt, runs the Workflow SDK's long-lived Postgres worker, and provides the internal Agent endpoints. It uses the installed system Chromium at `/usr/bin/chromium`; both Agent 2 and Agent 3 browser fallbacks are enabled through the existing runtime switch.

The worker also requires `NUSIFT_SELF_HOSTED=true`. This explicit marker prevents the self-hosted queue consumer from starting in the existing Vercel deployment.

`scheduler` only calls the two current Vercel-equivalent internal endpoints at 03:00 and 05:30 UTC. The durable workflow and database locks remain responsible for idempotency.

`cloudflared` is optional and connects the private `app` service to a named Cloudflare Tunnel. No database or internal-worker port is published to the LAN or internet.

## First Server Deployment

1. On the Ubuntu host, install Git and clone the intended, reviewed branch under `/srv/nusift`.
2. Copy `deploy/self-hosted/.env.example` to `deploy/self-hosted/.env`, generate the three distinct hex secrets, and copy the currently required OAuth, VAPID, mail, and admin configuration without committing the file.
3. Set `NUXT_PUBLIC_APP_URL` to the final HTTPS hostname before users create or renew push subscriptions. A URL change requires users to re-subscribe.
4. If the public hostname changes, add the new callback URL to the Google and Apple OAuth provider configuration before cutover. Keep the existing VAPID keypair to preserve existing push subscriptions on the same origin.
5. Build and start the private stack:

```bash
cd /srv/nusift
docker compose --env-file deploy/self-hosted/.env -f docker-compose.self-hosted.yml up -d --build
docker compose --env-file deploy/self-hosted/.env -f docker-compose.self-hosted.yml ps
docker compose --env-file deploy/self-hosted/.env -f docker-compose.self-hosted.yml logs --tail=150 bootstrap app scheduler
```

6. Verify the app from the host before exposing it:

```bash
docker compose --env-file deploy/self-hosted/.env -f docker-compose.self-hosted.yml exec app node -e "fetch('http://127.0.0.1:3000/api/ping').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"
```

7. Create a Cloudflare named tunnel with a public hostname pointing to `http://app:3000`, add its token to the env file, then start it:

```bash
docker compose --env-file deploy/self-hosted/.env -f docker-compose.self-hosted.yml --profile tunnel up -d
```

Do not forward ports 3000 or 5432 from the router. The tunnel is the only public ingress.

## Data Migration Cutover

Do not point the self-hosted application at production while Vercel is still writing to the same database.

1. Back up the existing production database using its provider's supported export method.
2. Stop the Vercel cron triggers and confirm no pipeline run or durable workflow is active.
3. Restore into the self-hosted `nusift` database before first app start. Do not restore into `nusift_workflow`; that database is created and migrated by `bootstrap`.
4. Start this stack without the tunnel, verify the admin telemetry, execute a controlled Agent 1/2/3 run, then verify browser fallback with a known recoverable article.
5. Enable the tunnel, update the final application hostname/DNS, and only then direct users to the new host.

The old Vercel deployment should remain available as a rollback target until the first full daily pipeline and notification cycle complete successfully on the new host.

## Backups And Updates

Create a backup on the host before every release and copy it off-host:

```bash
docker compose --env-file deploy/self-hosted/.env -f docker-compose.self-hosted.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "nusift-$(date +%F).dump"
```

For each reviewed release, pull the commit, rebuild, and inspect the bootstrap and app logs:

```bash
git pull --ff-only
docker compose --env-file deploy/self-hosted/.env -f docker-compose.self-hosted.yml up -d --build
docker compose --env-file deploy/self-hosted/.env -f docker-compose.self-hosted.yml logs --tail=150 bootstrap app
```

Never run `docker compose down -v` on this stack unless the database volume is intentionally being destroyed.
