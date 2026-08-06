import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { dailyDigestDedupeKey, isUniqueConstraintConflict } from "../../server/utils/notification-idempotency";

const databaseUrl = process.env.DATABASE_URL || "";
let parsedDatabaseUrl: URL | null = null;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  parsedDatabaseUrl = null;
}
const hostname = parsedDatabaseUrl?.hostname.replace(/^\[|\]$/g, "");
const localHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
const postgresUrl = parsedDatabaseUrl?.protocol === "postgres:" || parsedDatabaseUrl?.protocol === "postgresql:";
const runIntegration = process.env.NUSIFT_RUN_NOTIFICATION_DEDUPE_INTEGRATION === "1"
  && localHost
  && postgresUrl;
const migrationSql = readFileSync(
  resolve(process.cwd(), "prisma/migrations/20260806000000_add_notification_dedupe_key/migration.sql"),
  "utf8",
);

describe.skipIf(!runIntegration)("notification dedupe PostgreSQL integration", () => {
  it("produces real Prisma P2002 for one of two independent claims", async () => {
    // Explicit opt-in plus strict localhost-only validation prevents remote or
    // production access. The schema and all clients are randomized and local.
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    const schema = `notification_dedupe_${randomUUID().replace(/-/g, "")}`;
    let firstPool: Pool | undefined;
    let secondPool: Pool | undefined;
    let first: PrismaClient | undefined;
    let second: PrismaClient | undefined;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query(`CREATE TYPE "NotificationType" AS ENUM ('DAILY_DIGEST', 'BREAKING_SYSTEM', 'FRIEND_REQUEST', 'FRIEND_REQUEST_ACCEPTED', 'FRIEND_REQUEST_DECLINED')`);
      await admin.query(`CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED')`);
      await admin.query(`CREATE TYPE "NotificationScheduleSlot" AS ENUM ('MORNING', 'NOON', 'EVENING')`);
      await admin.query(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY)`);
      await admin.query(`CREATE TABLE "Notification" (
        "id" TEXT PRIMARY KEY,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "userId" TEXT,
        "type" "NotificationType" NOT NULL,
        "title" TEXT NOT NULL,
        "body" TEXT NOT NULL,
        "url" TEXT,
        "payload" JSONB,
        "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
        "sentAt" TIMESTAMP(3),
        "readAt" TIMESTAMP(3),
        "scheduledFor" "NotificationScheduleSlot",
        "errorLog" TEXT
      )`);
      await admin.query(`ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL`);
      await admin.query(`INSERT INTO "User" ("id") VALUES ('integration-user')`);
      // Apply the exact forward migration against the isolated legacy-shaped table.
      await admin.query(migrationSql);

      firstPool = new Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path="${schema}"` });
      secondPool = new Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path="${schema}"` });
      first = new PrismaClient({ adapter: new PrismaPg(firstPool) });
      second = new PrismaClient({ adapter: new PrismaPg(secondPool) });

      const key = dailyDigestDedupeKey("integration-user", new Date(Date.UTC(2026, 7, 6)));
      const create = (client: PrismaClient) => client.notification.create({
        data: {
          id: randomUUID(),
          userId: "integration-user",
          type: "DAILY_DIGEST",
          title: "Integration",
          body: "Integration",
          dedupeKey: key,
          status: "SENT",
        },
      });
      const results = await Promise.allSettled([create(first), create(second)]);
      const successes = results.filter((result) => result.status === "fulfilled");
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.reason?.code).toBe("P2002");
      expect(isUniqueConstraintConflict(failures[0]!.reason)).toBe(true);

      // The complete sender's mocked conflict-path test verifies this same
      // classification prevents push. This real-client test verifies the
      // database error shape consumed by that path.
      const pushAttemptsForLosingClaim = isUniqueConstraintConflict(failures[0]!.reason) ? 0 : 1;
      expect(pushAttemptsForLosingClaim).toBe(0);
    } finally {
      await first?.$disconnect().catch(() => undefined);
      await second?.$disconnect().catch(() => undefined);
      await firstPool?.end().catch(() => undefined);
      await secondPool?.end().catch(() => undefined);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});
