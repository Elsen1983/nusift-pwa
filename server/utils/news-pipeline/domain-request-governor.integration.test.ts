import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import {
  acquireDomainPermit,
  recoverExpiredDomainLeases,
  releaseDomainPermit,
  recordDomainOutcome,
} from "./domain-request-governor";

const databaseUrl = process.env.DATABASE_URL || "";
let parsed: URL | null = null;
try { parsed = new URL(databaseUrl); } catch { parsed = null; }
const hostname = parsed?.hostname?.replace(/^\[|\]$/g, "");
const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
const isPostgres = parsed?.protocol === "postgres:" || parsed?.protocol === "postgresql:";
const enabled = process.env.NUSIFT_RUN_DOMAIN_GOVERNOR_INTEGRATION === "1";
if (enabled && (!databaseUrl || !isLocal || !isPostgres)) {
  throw new Error("Domain governor integration requires explicit localhost PostgreSQL DATABASE_URL.");
}
const suite = enabled ? describe : describe.skip;
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

suite("domain request governor PostgreSQL concurrency", () => {
  it("uses the forward migration shape, allows one lease winner, rejects stale tokens, and recovers expiry", async () => {
    const schema = `domain_governor_${randomUUID().replaceAll("-", "")}`;
    const adminPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    const poolA = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    const poolB = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    const clientA = new PrismaClient({ adapter: new PrismaPg(poolA, { schema }) });
    const clientB = new PrismaClient({ adapter: new PrismaPg(poolB, { schema }) });
    try {
      await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      const migrationPath = resolve(process.cwd(), "prisma/migrations/20260810000000_add_domain_request_governor/migration.sql");
      const migrationSql = readFileSync(migrationPath, "utf8").replaceAll('"DomainRequestGovernor"', `${quoteIdentifier(schema)}."DomainRequestGovernor"`);
      await adminPool.query(migrationSql);
      const columns = await adminPool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'DomainRequestGovernor'",
        [schema],
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
        "domainKey", "circuitState", "cooldownUntil", "nextRequestAt", "activeLeaseToken",
        "activeLeaseExpiresAt", "version", "consecutive429Count", "consecutive403Count",
        "lastHttpStatus", "lastSuccessAt", "lastBlockedAt", "lastDecision", "lastDecisionAt",
      ]));
      const indexes = await adminPool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'DomainRequestGovernor'",
        [schema],
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
        "DomainRequestGovernor_pkey",
        "DomainRequestGovernor_activeLeaseExpiresAt_idx",
        "DomainRequestGovernor_circuitState_cooldownUntil_idx",
        "DomainRequestGovernor_nextRequestAt_idx",
      ]));

      const dbA = clientA as any;
      const dbB = clientB as any;
      const now = new Date("2026-08-10T12:00:00.000Z");
      const [first, second] = await Promise.all([
        acquireDomainPermit({ url: "https://www.example.com/a", mode: "enforce", now, db: dbA, leaseTtlMs: 30_000 }),
        acquireDomainPermit({ url: "https://example.com/b", mode: "enforce", now, db: dbB, leaseTtlMs: 30_000 }),
      ]);
      expect([first.allowed, second.allowed].filter(Boolean)).toHaveLength(1);
      const winner = first.allowed ? first : second;
      const loser = first.allowed ? second : first;
      expect(loser.reason).toMatch(/active-lease-held|half-open-probe-unavailable/);

      const stale = await releaseDomainPermit({ url: "https://example.com/a", mode: "enforce", leaseToken: "stale-token", now, db: dbB });
      expect(stale).toMatchObject({ released: false, reason: "token-mismatch" });

      const winnerDb = first.allowed ? dbA : dbB;
      const winnerUrl = first.allowed ? "https://www.example.com/a" : "https://example.com/b";
      const recorded = await recordDomainOutcome({ url: winnerUrl, mode: "enforce", leaseToken: winner.leaseToken, outcome: { kind: "success", status: 200 }, now, db: winnerDb });
      expect(recorded.recorded).toBe(true);

      // Two independent clients compete for an expired OPEN-domain half-open
      // probe; exactly one CAS winner may transition it to HALF_OPEN.
      await clientA.domainRequestGovernor.create({
        data: {
          domainKey: "half-open.example.com",
          circuitState: "OPEN",
          cooldownUntil: new Date(now.getTime() - 1_000),
          version: 11,
        },
      });
      const [probeA, probeB] = await Promise.all([
        acquireDomainPermit({ url: "https://half-open.example.com/a", mode: "enforce", now, db: dbA }),
        acquireDomainPermit({ url: "https://half-open.example.com/b", mode: "enforce", now, db: dbB }),
      ]);
      expect([probeA.allowed, probeB.allowed].filter(Boolean)).toHaveLength(1);
      expect([probeA.reason, probeB.reason]).toContain("half-open-probe-granted");

      // Create a second, intentionally expired lease through the real Prisma
      // client. Recovery must clear only the matching expired token/version.
      await clientA.domainRequestGovernor.create({
        data: {
          domainKey: "recovery.example.com",
          circuitState: "CLOSED",
          version: 7,
          activeLeaseToken: "expired-token",
          activeLeaseExpiresAt: new Date(now.getTime() - 1_000),
          lastDecision: "allowed",
          lastDecisionAt: now,
        },
      });
      const recovery = await recoverExpiredDomainLeases({ mode: "enforce", now, limit: 10, db: dbB });
      expect(recovery).toMatchObject({ scanned: 1, recovered: 1 });
      const recovered = await clientB.domainRequestGovernor.findUnique({ where: { domainKey: "recovery.example.com" } });
      expect(recovered?.activeLeaseToken).toBeNull();
      expect(recovered?.version).toBe(8);

      // The stale token cannot release or overwrite a newer lease.
      const staleAfterRecovery = await releaseDomainPermit({ url: "https://recovery.example.com/a", mode: "enforce", leaseToken: "expired-token", now, db: dbA });
      expect(staleAfterRecovery.reason).toBe("token-mismatch");
      const replacement = await acquireDomainPermit({ url: "https://recovery.example.com/new", mode: "enforce", now: new Date(now.getTime() + 1_000), db: dbA });
      expect(replacement.allowed).toBe(true);
      const beforeStaleOutcome = await clientB.domainRequestGovernor.findUnique({ where: { domainKey: "recovery.example.com" } });
      const staleReleaseAfterReplacement = await releaseDomainPermit({ url: "https://recovery.example.com/old", mode: "enforce", leaseToken: "expired-token", now: new Date(now.getTime() + 1_000), db: dbB });
      expect(staleReleaseAfterReplacement.reason).toBe("token-mismatch");
      const staleOutcome = await recordDomainOutcome({ url: "https://recovery.example.com/old", mode: "enforce", leaseToken: "expired-token", outcome: { kind: "success", status: 200 }, now: new Date(now.getTime() + 1_000), db: dbB });
      expect(staleOutcome.reason).toBe("token-mismatch");
      const afterStaleOutcome = await clientB.domainRequestGovernor.findUnique({ where: { domainKey: "recovery.example.com" } });
      expect(afterStaleOutcome?.activeLeaseToken).toBe(beforeStaleOutcome?.activeLeaseToken);
      expect(afterStaleOutcome?.version).toBe(beforeStaleOutcome?.version);
    } finally {
      await clientA.$disconnect().catch(() => undefined);
      await clientB.$disconnect().catch(() => undefined);
      await poolA.end().catch(() => undefined);
      await poolB.end().catch(() => undefined);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined);
      await adminPool.end().catch(() => undefined);
    }
  }, 120_000);
});
