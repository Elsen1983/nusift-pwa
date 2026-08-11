import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL || "";
let parsed: URL | null = null;
try { parsed = new URL(databaseUrl); } catch { parsed = null; }
const host = parsed?.hostname?.replace(/^\[|\]$/g, "");
const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
const postgres = parsed?.protocol === "postgres:" || parsed?.protocol === "postgresql:";
const enabled = process.env.NUSIFT_RUN_ADMIN_INSPECTION_APPLICATION_INTEGRATION === "1";
if (enabled && (!local || !postgres || !databaseUrl)) {
  throw new Error("Application isolation integration requires an explicitly opted-in localhost PostgreSQL DATABASE_URL (NUSIFT_RUN_ADMIN_INSPECTION_APPLICATION_INTEGRATION=1).");
}

/**
 * Application-level isolation proof (Prompt 13G/13H).
 *
 * Executes ONLY when NUSIFT_RUN_ADMIN_INSPECTION_APPLICATION_INTEGRATION=1 and
 * DATABASE_URL points at localhost PostgreSQL. It provisions a randomized
 * isolated schema, applies the REAL Prisma migration files, seeds
 * production-shaped fixtures through the REAL Prisma client, then invokes the
 * REAL framework-independent application code paths directly — the inspection
 * authorization guard, inspection access, source inspection, article
 * inspection (snapshot reuse + explicit), article detail, feed selection and
 * notification article selection — with the isolated schema-scoped client.
 *
 * There are NO handler imports: the endpoint modules are thin
 * `defineEventHandler` wrappers that depend on Nuxt auto-import globals, so
 * the integration test exercises the exact same service functions the
 * production handlers call (the defineEventHandler ReferenceError from
 * Prompt 13G cannot occur because no endpoint module is imported).
 *
 * Every application-code import and every pool lives inside the protected
 * try/finally lifecycle: if an import or query fails, the finally block still
 * disconnects the Prisma clients, ends the pools and drops the randomized
 * schema.
 *
 * Before/after fingerprints over every mutable model prove inspection is
 * read-only, the normal feed stays subscription-scoped, and inspection-only
 * articles never leak into the feed or the notification digest scope.
 */
const describeIntegration = enabled ? describe : describe.skip;

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

const migrationFiles = () => {
  const migrationsDir = resolve(process.cwd(), "prisma/migrations");
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(migrationsDir, name, "migration.sql"), "utf8") }));
};

type Fingerprint = { before: unknown; after: unknown };

describeIntegration("admin inspection application-level isolation (real PostgreSQL)", () => {
  it("runs real inspection services against an isolated migrated schema without mutating any state", async () => {
    const adminEmail = "inspection.admin@example.com";
    const adminId = `admin-${randomUUID().slice(0, 8)}`;
    const normalId = `normal-${randomUUID().slice(0, 8)}`;
    const schema = `inspection_app_${randomUUID().replaceAll("-", "")}`;

    const savedEnv: Record<string, string | undefined> = {
      NUXT_ADMIN_EMAILS: process.env.NUXT_ADMIN_EMAILS,
      JWT_SECRET: process.env.JWT_SECRET,
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
      NODE_ENV: process.env.NODE_ENV,
    };
    process.env.NUXT_ADMIN_EMAILS = adminEmail;
    process.env.JWT_SECRET = `isolation-test-${randomUUID()}`;
    // The in-memory rate limiter keeps services local without external Redis.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.NODE_ENV;

    let adminPool: Pool | undefined;
    let clientPool: Pool | undefined;
    let client: PrismaClient | undefined;

    try {
      // ---------------------------------------------------------------------
      // Framework-independent application code, imported INSIDE the protected
      // lifecycle so a failed import still reaches the finally cleanup.
      // ---------------------------------------------------------------------
      const { runAdminInspectionAccess, runAdminSourceInspection, runAdminArticleInspection, runAdminArticleInspectionDetail } = await import("../server/services/admin-inspection");
      const { requireInspectionAdmin } = await import("../server/utils/require-inspection-admin");
      const { loadUserFeed, countScopedPublishableArticles } = await import("../server/services/user-feed");
      const { getSubscriptionScope } = await import("../server/utils/subscription-scope");

      adminPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });

      const fingerprints = new Map<string, Fingerprint>();
      const captureFingerprint = async (table: string) => {
        fingerprints.set(table, {
          before: (await adminPool!.query(`SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ORDER BY 1`)).rows,
          after: null,
        });
      };
      const assertUnchanged = () => {
        for (const [table, fingerprint] of fingerprints) {
          expect(fingerprint.after, `mutable model ${table} changed during inspection`).toEqual(fingerprint.before);
        }
      };
      const refreshFingerprints = async () => {
        for (const table of [...fingerprints.keys()]) {
          fingerprints.get(table)!.after = (await adminPool!.query(`SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ORDER BY 1`)).rows;
        }
      };

      // --- Provision the isolated schema from the REAL migrations ----------
      await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await adminPool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      const migrations = migrationFiles();
      expect(migrations.length).toBeGreaterThan(20);
      for (const migration of migrations) {
        await adminPool.query(migration.sql);
      }
      // Fail closed: verify the schema actually contains the production shape.
      const tables = (await adminPool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = ${quoteIdentifier(schema).replace(/"/g, "'")}`,
      )).rows.map((row: any) => row.table_name);
      for (const required of ["User", "NewsSource", "SourceCategory", "Article", "PipelineArtifact", "Notification", "PushSubscription", "PipelineRun"]) {
        expect(tables, `missing ${required} in migrated schema`).toContain(required);
      }

      clientPool = new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 10_000,
        options: `-c search_path=${quoteIdentifier(schema)}`,
      });
      client = new PrismaClient({ adapter: new PrismaPg(clientPool, { schema }) });

      // --- Production-shaped fixtures through the REAL Prisma client -------
      await client.user.createMany({
        data: [
          { id: adminId, email: adminEmail, role: "ADMIN", isVerified: true },
          { id: normalId, email: "normal.user@example.com", role: "USER", isVerified: true, tier: "FREE" },
          { id: "role-admin-only", email: "role.admin@example.com", role: "ADMIN", isVerified: true },
          { id: "spoofed-user", email: "spoofed@example.com", role: "USER", isVerified: true },
        ],
      });
      const sourceSubscribed = await client.newsSource.create({ data: { id: "source-1", mediaName: "Subscribed Source", frontPageUrl: "https://subscribed.example.com", rssStatus: "ACTIVE", currentFeedProductive: true } });
      // Inspection-only source: NOT subscribed and NOT part of the active
      // universe (failed RSS), so its article is visible only to explicit
      // inspection — never to the feed or the all-active snapshot universe.
      await client.newsSource.create({ data: { id: "source-2", mediaName: "Inspection-Only Source", frontPageUrl: "https://inspection-only.example.com", rssStatus: "FAILED" } });
      await client.sourceCategory.create({ data: { id: "category-1", newsSourceId: sourceSubscribed.id, name: "Subscribed Category", pathUrl: "/subscribed", rssStatus: "ACTIVE" } });
      await client.userSourceSubscription.create({ data: { id: "sub-1", userId: normalId, sourceId: "source-1", isActive: true } });
      await client.userCategorySubscription.create({ data: { id: "cat-sub-1", userId: normalId, categoryId: "category-1", isActive: true } });

      const now = new Date();
      const publishable = {
        publicationStatus: "PUBLISHED" as const,
        publicationStage: "agent3",
        publicationReadyAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        enrichmentStatus: "ENRICHED",
        processingStage: "INGESTED",
        processingStatus: "SUCCESS",
        bodyText: "A".repeat(600),
      };
      await client.article.create({
        data: { id: 1, title: "Subscribed article", sourceId: "source-1", canonicalUrl: "https://subscribed.example.com/a1", date: new Date(now.getTime() - 3 * 60 * 60 * 1000), ...publishable },
      });
      await client.article.create({
        data: { id: 2, title: "Inspection-only article", sourceId: "source-2", canonicalUrl: "https://inspection-only.example.com/a2", date: new Date(now.getTime() - 4 * 60 * 60 * 1000), ...publishable },
      });

      const run = await client.pipelineRun.create({ data: { status: "COMPLETED", summary: { kind: "integration_fixture" } } });
      await client.pipelineArtifact.createMany({
        data: [
          { id: "artifact-1", pipelineRunId: run.id, sourceId: "source-1", artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "productive" } },
          { id: "artifact-2", pipelineRunId: run.id, sourceId: "source-2", artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "productive" } },
        ],
      });
      await client.notification.create({ data: { id: "notification-1", userId: normalId, type: "DAILY_DIGEST", title: "Digest", body: "Existing digest", status: "SENT" } });
      await client.pushSubscription.create({ data: { id: "push-1", userId: normalId, endpoint: "https://push.invalid/example", p256dh: "p256dh", auth: "auth", isActive: true } });

      // --- Before fingerprints over all mutable models ----------------------
      await captureFingerprint("UserSourceSubscription");
      await captureFingerprint("UserCategorySubscription");
      await captureFingerprint("User");
      await captureFingerprint("Notification");
      await captureFingerprint("PushSubscription");
      await captureFingerprint("Article");
      await captureFingerprint("PipelineArtifact");
      await captureFingerprint("PipelineRun");

      // --- Invoke REAL application code -------------------------------------
      // The H3 authorization guard with a real session identity: configured
      // email is the authority, not the role claim.
      const adminEvent = { context: { prisma: client, user: { id: adminId } } };
      await expect(requireInspectionAdmin(adminEvent as any)).resolves.toBe(adminId);
      await expect(runAdminInspectionAccess(client, adminId)).resolves.toMatchObject({ ok: true, allowed: true });

      const dateFrom = new Date(now.getTime() - 30 * 86400000).toISOString();
      const dateTo = now.toISOString();
      const sourceResult: any = await runAdminSourceInspection(client, adminId, { limit: "50", targetType: "ALL", dateFrom, dateTo });
      expect(sourceResult.ok).toBe(true);
      expect(sourceResult.snapshotToken).toEqual(expect.any(String));
      expect(sourceResult.snapshot.available).toBe(true);
      expect(sourceResult.items.length).toBeGreaterThanOrEqual(1);

      // All-active article inspection reuses the source snapshot via the same
      // service call the POST endpoint performs: exact validated IDs. The
      // failed inspection-only source is outside the active universe, so its
      // article cannot appear here.
      const articleResult: any = await runAdminArticleInspection(client, adminId, { limit: "50", allActive: true, targetType: "ALL", snapshot: sourceResult.snapshotToken, dateFrom, dateTo });
      expect(articleResult.selection.snapshotSource).toBe("client-provided");
      const articleIds = articleResult.items.map((item: any) => item.articleId);
      expect(articleIds).toContain(1);
      expect(articleIds).not.toContain(2);

      // Explicit inspection of the non-subscribed source proves inspection
      // sees inspection-only articles that the feed must not expose.
      const explicitResult: any = await runAdminArticleInspection(client, adminId, { limit: "50", targetIds: "source-2", targetType: "SOURCE", dateFrom, dateTo });
      expect(explicitResult.items.map((item: any) => item.articleId)).toContain(2);

      const detailResult: any = await runAdminArticleInspectionDetail(client, adminId, 1);
      expect(detailResult.item.articleId).toBe(1);

      // Feed selection: subscription-scoped real service with the isolated client.
      const feed = await loadUserFeed(client, normalId);
      expect(feed.map((article: any) => article.id)).toEqual([1]);
      expect(feed.some((article: any) => article.id === 2)).toBe(false);

      // Notification article selection: same service the sender uses.
      const user = await client.user.findUnique({ where: { id: normalId }, select: { sourceSubscriptions: { where: { isActive: true }, select: { sourceId: true } }, categorySubscriptions: { where: { isActive: true }, select: { categoryId: true, category: { select: { pathUrl: true } } } } } });
      const scope = getSubscriptionScope(user?.sourceSubscriptions ?? [], user?.categorySubscriptions ?? []);
      const digestArticleCount = await countScopedPublishableArticles(client, scope, now);
      expect(digestArticleCount).toBe(1);

      // --- Authorization matrix through the REAL guard ----------------------
      await expect(requireInspectionAdmin({ context: { prisma: client, user: { id: "role-admin-only" } } } as any)).rejects.toMatchObject({ statusCode: 403 });
      await expect(requireInspectionAdmin({ context: { prisma: client, user: { id: normalId } } } as any)).rejects.toMatchObject({ statusCode: 403 });
      await expect(requireInspectionAdmin({ context: { prisma: client } } as any)).rejects.toMatchObject({ statusCode: 401 });
      await expect(requireInspectionAdmin({
        context: { prisma: client, user: { id: "spoofed-user" } },
        headers: { get: () => adminEmail },
        body: { email: adminEmail },
      } as any)).rejects.toMatchObject({ statusCode: 403 });

      // --- After fingerprints: nothing changed -------------------------------
      await refreshFingerprints();
      assertUnchanged();

      // Inspection created no admin subscriptions and modified no quotas.
      const adminSubs = await client.userSourceSubscription.count({ where: { userId: adminId } });
      const adminCatSubs = await client.userCategorySubscription.count({ where: { userId: adminId } });
      expect(adminSubs).toBe(0);
      expect(adminCatSubs).toBe(0);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await client?.$disconnect().catch(() => undefined);
      await clientPool?.end().catch(() => undefined);
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined);
        await adminPool.end().catch(() => undefined);
      }
    }
  }, 180_000);
});
