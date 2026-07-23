/**
 * check-agent2-browser-runtime.ts
 *
 * Lightweight sanity check for the Agent 2 Docker browser runtime.
 * Verifies:
 *   - NUXT_ENABLE_AGENT2_BROWSER_FALLBACK is true
 *   - DATABASE_URL is present
 *   - playwright-core can be imported
 *   - @sparticuz/chromium can be imported
 *   - chromium.executablePath() resolves
 *   - Prisma can connect to the DB with a lightweight query
 *
 * Run inside Docker (or locally) with:
 *   npx tsx scripts/dev/check-agent2-browser-runtime.ts
 */

import "./load-env";

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

// ── 1. Environment variables ────────────────────────────────────────────────

const browserFallback = (process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK || "").trim().toLowerCase();
record(
  "NUXT_ENABLE_AGENT2_BROWSER_FALLBACK",
  browserFallback === "true",
  browserFallback === "true" ? "true" : `got "${process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK || "(empty)"}"`,
);

const databaseUrl = process.env.DATABASE_URL;
record(
  "DATABASE_URL",
  Boolean(databaseUrl),
  databaseUrl ? `${databaseUrl.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@")}` : "missing",
);

record(
  "VERCEL env (info)",
  true,
  process.env.VERCEL ? `VERCEL=${process.env.VERCEL} (production browser path active)` : "not set (expected on host; Dockerfile sets this)",
);

// ── 2. playwright-core import ───────────────────────────────────────────────

try {
  const pw = await import("playwright-core");
  const pwVersion = (pw as any).default?.version ?? (pw as any).version ?? "unknown";
  record("playwright-core import", true, `version: ${pwVersion}`);
} catch (err: any) {
  record("playwright-core import", false, err?.message || String(err));
}

// ── 3. @sparticuz/chromium import + executablePath ──────────────────────────

try {
  const chromium = await import("@sparticuz/chromium");
  const mod = chromium.default ?? chromium;
  const execPath = await mod.executablePath();
  record("@sparticuz/chromium import", true, "ok");
  record("chromium.executablePath()", Boolean(execPath), execPath || "(empty)");
} catch (err: any) {
  record("@sparticuz/chromium import", false, err?.message || String(err));
  record("chromium.executablePath()", false, "skipped — import failed");
}

// ── 4. Prisma DB connection ─────────────────────────────────────────────────

if (databaseUrl) {
  try {
    const { prisma } = await import("../../server/utils/prisma");
    const result = await prisma.$queryRaw`SELECT 1 AS ok`;
    record("Prisma DB connection", true, JSON.stringify(result));
    await prisma.$disconnect();
  } catch (err: any) {
    record("Prisma DB connection", false, err?.message || String(err));
  }
} else {
  record("Prisma DB connection", false, "skipped — DATABASE_URL missing");
}

// ── Report ──────────────────────────────────────────────────────────────────

const allPassed = checks.every((c) => c.ok);

console.log("\n── Agent 2 Browser Runtime Check ─────────────────────────────────\n");
for (const c of checks) {
  const icon = c.ok ? "✓" : "✗";
  console.log(`  ${icon} ${c.name}: ${c.detail}`);
}
console.log(`\n  Result: ${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}\n`);

if (!allPassed) {
  process.exit(1);
}
