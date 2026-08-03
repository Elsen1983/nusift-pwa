#!/usr/bin/env node
/**
 * Local-only authenticated admin browser fixture (test harness).
 *
 * This harness renders the REAL /audit/admin page exactly as an authenticated
 * admin sees it, using only local, throwaway resources:
 *
 *  1. An in-memory PGlite PostgreSQL socket server (no files, no network DB)
 *     that holds a single fixture admin row so the REAL session-guard and
 *     route middleware can validate a REAL signed session cookie.
 *  2. The REAL Nuxt dev server (SSR + client) with a fixture JWT secret and a
 *     DATABASE_URL pointing at the in-memory PGlite socket.
 *  3. A mock API + proxy server that answers the admin page's /api/dev/* and
 *     /api/auth/* calls with bounded fixture data and proxies all other
 *     traffic (document + assets + HMR websockets) to the Nuxt dev server.
 *
 * Guard rails (never weakened by this fixture):
 *  - refuses to start when NODE_ENV === "production" or when the explicit
 *    NUSIFT_ADMIN_FIXTURE=1 opt-in is missing;
 *  - uses only a random fixture JWT secret and a localhost PGlite socket —
 *    no production credentials, DB, API, or secrets are read or used;
 *  - destructive admin endpoints are MOCKED read-only: the mock answers the
 *    dry-run repair with a fixture result and returns 403 for any real write
 *    (e.g. hard-source repair with dryRun=false), so a visual verification
 *    can never execute a destructive action;
 *  - every request the mock receives is written to
 *    browser-verify/requests.log so the "no destructive call executed"
 *    evidence can be audited afterwards.
 *
 * Usage:
 *   NUSIFT_ADMIN_FIXTURE=1 node scripts/dev/admin-browser-fixture.mjs
 *   NUSIFT_ADMIN_FIXTURE=1 node scripts/dev/admin-browser-fixture.mjs --port 3457 --nuxt-port 3456
 *
 * Then open http://127.0.0.1:3457/__fixture/seed in Chrome (it seeds the
 * local-only session + admin profile and redirects to /audit/admin).
 */

import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import jwt from "jsonwebtoken";

// ─── Guard rails ────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  console.error("admin-browser-fixture: refusing to run with NODE_ENV=production.");
  process.exit(1);
}
if (process.env.NUSIFT_ADMIN_FIXTURE !== "1") {
  console.error("admin-browser-fixture: NUSIFT_ADMIN_FIXTURE=1 is required (local-only opt-in).");
  process.exit(1);
}

const ROOT = resolve(import.meta.dirname ?? process.cwd(), "..", "..");
const NUXT_PORT = Number(process.env.FIXTURE_NUXT_PORT || 3456);
const FIXTURE_PORT = Number(process.env.FIXTURE_PORT || 3457);
const PGLITE_PORT = Number(process.env.FIXTURE_PGLITE_PORT || 5460);
const ARTIFACT_DIR = join(ROOT, "browser-verify");
const REQUEST_LOG = join(ARTIFACT_DIR, "requests.log");
const NUXT_LOG = join(ARTIFACT_DIR, "nuxt-dev.log");

mkdirSync(ARTIFACT_DIR, { recursive: true });
if (existsSync(REQUEST_LOG)) writeFileSync(REQUEST_LOG, "");
writeFileSync(NUXT_LOG, "");

const log = (line) => {
  const stamp = new Date().toISOString();
  console.log(`[fixture ${stamp}] ${line}`);
};
const logRequest = (line) => {
  appendFileSync(REQUEST_LOG, `${new Date().toISOString()} ${line}\n`);
};

// ─── Fixture identities ─────────────────────────────────────────────────────
const FIXTURE_USER = {
  id: "fixture-admin-00000000-0000-4000-8000-000000000001",
  email: "fixture@nusift.local",
  role: "ADMIN",
  tokenVersion: 0,
  onboardingStep: 3,
};
const FIXTURE_JWT_SECRET = "admin-browser-fixture-secret-not-for-production-0123456789abcdef";
const fixtureToken = jwt.sign(
  {
    userId: FIXTURE_USER.id,
    email: FIXTURE_USER.email,
    onboardingStep: FIXTURE_USER.onboardingStep,
    tokenVersion: FIXTURE_USER.tokenVersion,
  },
  FIXTURE_JWT_SECRET,
  {
    expiresIn: "2h",
    issuer: "nusift",
    audience: "nusift-api",
  },
);
const SESSION_COOKIE_HEADERS = [
  `auth_token=${fixtureToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200`,
  "session_status=active; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200",
];

// ─── 1. In-memory PGlite socket server (real session authority) ─────────────
async function startPglite() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const db = await PGlite.create();
  await db.exec(`
    CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
    CREATE TYPE "UserTier" AS ENUM ('FREE', 'PREMIUM');
    CREATE TYPE "NotificationScheduleSlot" AS ENUM ('MORNING', 'NOON', 'EVENING');
    CREATE TABLE IF NOT EXISTS "User" (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      role "UserRole" NOT NULL DEFAULT 'USER',
      "passwordHash" TEXT,
      "isVerified" BOOLEAN NOT NULL DEFAULT FALSE,
      tier "UserTier" NOT NULL DEFAULT 'FREE',
      "tokenVersion" INTEGER NOT NULL DEFAULT 0,
      "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
      "onboardingStep" INTEGER NOT NULL DEFAULT 0,
      "notificationScheduleSlot" "NotificationScheduleSlot" NOT NULL DEFAULT 'MORNING',
      "allowBreakingNotifications" BOOLEAN NOT NULL DEFAULT TRUE,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.exec(
    `    INSERT INTO "User" (id, email, role, "tokenVersion", "onboardingStep")
     VALUES ('${FIXTURE_USER.id}', '${FIXTURE_USER.email}', 'ADMIN', ${FIXTURE_USER.tokenVersion}, ${FIXTURE_USER.onboardingStep})
     ON CONFLICT (id) DO NOTHING;`,
  );
  const server = new PGLiteSocketServer({ db, port: PGLITE_PORT, host: "127.0.0.1" });
  await server.start();
  log(`PGlite session authority up on 127.0.0.1:${PGLITE_PORT}`);
  return { db, server };
}

// ─── 2. Nuxt dev server with fixture env ────────────────────────────────────
function startNuxt() {
  const nuxtBin = join(ROOT, "node_modules", "nuxt", "bin", "nuxt.mjs");
  const child = spawn(
    process.execPath,
    [nuxtBin, "dev", "--host", "127.0.0.1", "--port", String(NUXT_PORT)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "development",
        NUSIFT_ADMIN_FIXTURE: "1",
        DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PGLITE_PORT}/nusift?schema=public`,
        PRISMA_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PGLITE_PORT}/nusift?schema=public`,
        SHADOW_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PGLITE_PORT}/nusift_shadow?schema=public`,
        JWT_SECRET: FIXTURE_JWT_SECRET,
        NUXT_ADMIN_EMAILS: FIXTURE_USER.email,
        HOST: "127.0.0.1",
        PORT: String(NUXT_PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const write = (chunk) => appendFileSync(NUXT_LOG, String(chunk));
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  child.on("exit", (code, signal) => log(`Nuxt dev server exited (code=${code}, signal=${signal})`));
  log(`Nuxt dev server starting on 127.0.0.1:${NUXT_PORT} (pid ${child.pid})`);
  return child;
}

async function waitForNuxt(child, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Nuxt dev server exited during startup");
    try {
      const res = await fetch(`http://127.0.0.1:${NUXT_PORT}/api/ping`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Nuxt dev server did not become ready in time");
}

// ─── 3. Mock admin API + proxy ──────────────────────────────────────────────
const json = (res, status, body, extraHeaders = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new Error("invalid json"));
      }
    });
    req.on("error", rejectBody);
  });

const FIXTURE_ADMIN_VIEW = {
  id: FIXTURE_USER.id,
  email: FIXTURE_USER.email,
  role: "ADMIN",
  isAdmin: true,
  onboardingStep: 3,
  primaryRegion: null,
  preferredLanguage: "en",
  topSources: [],
  topInterests: [],
  tier: "FREE",
  profile: { id: FIXTURE_USER.id, nickname: "Fixture Admin" },
};

const MARKERS = [
  {
    id: "marker-fixture-1",
    dateKey: "2026-08-03",
    status: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
    createdAt: "2026-08-03T02:58:00.000Z",
    startState: "reconciliation_required",
    launchAttemptId: "launch-fixture-1",
    workflowRunId: "wf-fixture-1",
    launchAttemptedAt: "2026-08-03T02:58:00.000Z",
    staleLaunching: true,
    failureReason: "fixture: external outcome uncertain",
    summary: {
      currentSlot: "MORNING",
      nextSlot: "NOON",
      usersProcessed: 12,
      pushesSent: 18,
      skippedEmpty: 3,
      lastError: "fixture slot error",
      reconciliationRequired: true,
      retrySafe: false,
      firstSlotAttempted: true,
      deliveryStartedAt: "2026-08-03T06:00:00.000Z",
      completedSlots: ["MORNING"],
    },
    externalWorkflow: { exists: true, status: "failed" },
    resultingState: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
    reconciliationOutcome: "failed_retryable",
  },
  {
    id: "marker-fixture-2",
    dateKey: "2026-08-03",
    status: "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE",
    createdAt: "2026-08-03T02:58:00.000Z",
    startState: "failed_retryable",
    launchAttemptId: "launch-fixture-2",
    workflowRunId: null,
    launchAttemptedAt: "2026-08-03T02:58:00.000Z",
    staleLaunching: false,
    failureReason: "fixture: pre-delivery durable sleep failure",
    summary: {
      currentSlot: null,
      nextSlot: null,
      usersProcessed: 0,
      pushesSent: 0,
      skippedEmpty: 0,
      lastError: null,
      reconciliationRequired: false,
      retrySafe: true,
      firstSlotAttempted: false,
      deliveryStartedAt: null,
      completedSlots: [],
    },
    externalWorkflow: null,
    resultingState: "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE",
    reconciliationOutcome: "none",
  },
];

const TELEMETRY_RUN = {
  id: "run-fixture-1",
  status: "DAILY_PIPELINE_WORKFLOW_COMPLETED",
  createdAt: "2026-08-03T03:00:00.000Z",
  finishedAt: "2026-08-03T03:42:00.000Z",
  completedStages: ["agent1", "agent2-static", "agent2-headless", "agent3"],
  error: null,
  workflowDurationMs: 2520000,
  notificationsDurationMs: 180000,
  completion: {
    completionReason: "current_orchestration_drained",
    currentRunDrained: true,
    globallyComplete: false,
    eligibleNextRun: 175,
    retryableNextRun: 71,
    deferred: 71,
    quarantined: 23,
    nonRetryable: 12,
    nextRetryAt: "2026-08-04T04:00:00.000Z",
  },
};

const TELEMETRY_STAGES = [
  {
    stage: "agent1",
    durationMs: 720000,
    batches: 6,
    processed: 120,
    succeeded: 110,
    failedRetryable: 5,
    failedPermanent: 2,
    skipped: 3,
    deferred: 0,
    quarantined: 0,
    claimLost: 0,
    persistenceFailed: 0,
    batchSizeLimit: 20,
    concurrencyLimit: 8,
    peakConcurrency: 8,
    logicalRequestDurationMs: 120000,
    extractionDurationMs: 0,
    browserDurationMs: 0,
    persistenceDurationMs: 40000,
    sleepDurationMs: 0,
    remainingBefore: 200,
    remainingAfter: 80,
    accessDenied403: 1,
    rateLimited403: 0,
    rateLimited429: 2,
    timedOut: 0,
    latestNoProgressReason: null,
  },
  {
    stage: "agent2-static",
    durationMs: 540000,
    batches: 4,
    processed: 90,
    succeeded: 72,
    failedRetryable: 9,
    failedPermanent: 6,
    skipped: 3,
    deferred: 4,
    quarantined: 1,
    claimLost: 0,
    persistenceFailed: 0,
    batchSizeLimit: 25,
    concurrencyLimit: 6,
    peakConcurrency: 6,
    logicalRequestDurationMs: 90000,
    extractionDurationMs: 0,
    browserDurationMs: 0,
    persistenceDurationMs: 20000,
    sleepDurationMs: 0,
    remainingBefore: 120,
    remainingAfter: 30,
    accessDenied403: 2,
    rateLimited403: 1,
    rateLimited429: 3,
    timedOut: 1,
    latestNoProgressReason: null,
  },
  {
    stage: "agent2-headless",
    durationMs: 360000,
    batches: 2,
    processed: 18,
    succeeded: 12,
    failedRetryable: 3,
    failedPermanent: 1,
    skipped: 2,
    deferred: 2,
    quarantined: 0,
    claimLost: 0,
    persistenceFailed: 0,
    batchSizeLimit: 10,
    concurrencyLimit: 2,
    peakConcurrency: 2,
    logicalRequestDurationMs: 60000,
    extractionDurationMs: 0,
    browserDurationMs: 180000,
    persistenceDurationMs: 10000,
    sleepDurationMs: 0,
    remainingBefore: 20,
    remainingAfter: 2,
    accessDenied403: 0,
    rateLimited403: 0,
    rateLimited429: 2,
    timedOut: 0,
    latestNoProgressReason: null,
  },
  {
    stage: "agent3",
    durationMs: 540000,
    batches: 5,
    processed: 175,
    succeeded: 148,
    failedRetryable: 12,
    failedPermanent: 4,
    skipped: 11,
    deferred: 8,
    quarantined: 0,
    claimLost: 0,
    persistenceFailed: 1,
    batchSizeLimit: 40,
    concurrencyLimit: 4,
    peakConcurrency: 4,
    logicalRequestDurationMs: 180000,
    extractionDurationMs: 240000,
    browserDurationMs: 60000,
    persistenceDurationMs: 30000,
    sleepDurationMs: 0,
    remainingBefore: 200,
    remainingAfter: 25,
    accessDenied403: 2,
    rateLimited403: 0,
    rateLimited429: 4,
    timedOut: 0,
    latestNoProgressReason: null,
  },
];

const AGENT3_PROGRESS = {
  eligibleNow: 175,
  recentlyBlocked: 12,
  retryableNow: 71,
  nonRetryableCurrentVersionFailures: 12,
  totalInScope: 400,
  enrichedInScope: 290,
  needingInitialEnrichment: 110,
  failedRetryable: 71,
  needsCurrentVersionReprocess: 40,
  currentVersionComplete: 250,
  progressTruncated: false,
  progressScanned: 400,
  selectedMode: { includeEnriched: true, forceReprocess: true, hasArticleFilter: false, hasSourceFilter: false },
  latestRun: {
    pipelineRunId: "run-fixture-1",
    processed: 175,
    successfullyEnriched: 148,
    rejected: 10,
    persistedOutcomes: 158,
    systemPersistFailed: 1,
    durationMs: 540000,
    finishedAt: "2026-08-03T03:40:00.000Z",
    byKind: { SUCCESS: 148, LOW_CONTENT_QUALITY: 4, PAYWALL_BLOCKED: 3, RETRYABLE_FAILURE: 3 },
    browserFallbackStats: {
      enabled: true,
      attempted: 5,
      succeeded: 3,
      failed: 2,
      runtimeUnavailable: 0,
      rateLimited: 1,
      stoppedReason: null,
    },
  },
  remainingAfterLatestRun: 25,
};

const DEFAULT_HEADLESS_SUMMARY = {
  total: 0,
  byStatus: {},
  activeTotal: 0,
  historyTotal: 0,
  retryableTotal: 0,
  cooldownPendingTotal: 0,
  resolvedRecentTotal: 0,
  cooldownOnlyTotal: 0,
  retryableExcludingCooldown: 0,
};

const HARD_SOURCES = [
  {
    key: "fixture-hard-source-1",
    targetUrl: "https://example.com/hard-source",
    targetType: "source",
    sourceId: "src-fixture-1",
    categoryId: null,
    recommendedNextAction: "ai_inspection_candidate",
    lastStaticQuality: "low_quality",
    lastBrowserStatus: "runtime_unavailable",
    consecutiveFailedDiscoveryAttempts: 3,
    lastAcceptedCount: 0,
    lastInsertedCount: 0,
  },
];

const HARD_SOURCE_REPORT = {
  generatedAt: "2026-08-03T03:45:00.000Z",
  scannedArtifacts: 12,
  hardSources: HARD_SOURCES,
  total: 1,
  cooldownOnlyCount: 2,
  evidenceTargetCount: 12,
  qualifyingHardSourceCount: 1,
  resolvedOrProductiveCount: 9,
};

const HARD_SOURCE_PROFILES = [
  {
    id: "profile-fixture-1",
    sourceId: "src-fixture-1",
    categoryId: null,
    targetUrl: "https://example.com/hard-source",
    staticQuality: "low_quality",
    browserStatus: "runtime_unavailable",
    failureCount: 3,
    firstFailureAt: "2026-07-30T08:00:00.000Z",
    lastFailureAt: "2026-08-02T09:00:00.000Z",
    lastStaticStatus: "low_quality",
    lastBrowserStatus: "runtime_unavailable",
    lastAcceptedCount: 0,
    lastInsertedCount: 0,
    dominantReasons: ["http_429", "browser_runtime_unavailable"],
    suggestedNextAction: "ai_inspection_candidate",
    profileConfidence: "medium",
    lifecycleState: "active",
    recoverySuggestion: "recheck after cooldown",
    resolvedBy: null,
    resolvedAt: null,
    resolvedReason: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
  },
];

const RELIABILITY_DIAGNOSTICS = {
  ok: true,
  notifications: { markers: MARKERS },
  redirects: [
    {
      id: "art-redirect-1",
      sourceId: "src-fixture-2",
      categoryId: null,
      status: "PROCESSED",
      originalUrl: "https://example.com/redirect-origin",
      finalUrl: "https://example.com/redirect-final",
      urlHash: "abc123def456",
      failureKind: "http_429",
      redirectCount: 2,
      attemptCount: 3,
      nextRetryAt: "2026-08-03T05:00:00.000Z",
      terminalAt: null,
      httpStatus: 429,
      retryAfterMs: 3600000,
      createdAt: "2026-08-02T03:00:00.000Z",
    },
  ],
  rssSkipReasons: {
    rss_owned_productive: 14,
    rss_owned_waiting_evidence: 6,
    rss_owned_invalid_feed: 2,
    rss_owned_scope_mismatch: 1,
    rss_owned_repeatedly_non_productive: 1,
  },
  rssOwnership: {
    productiveSkip: 14,
    waitingForEvidenceSkip: 6,
    invalidFeedEscalation: 3,
    scopeMismatchEscalation: 1,
    explicitAdminBypass: "targeted requests only",
  },
  browserStatuses: { headless_ok: 9, runtime_unavailable: 1 },
  bounded: true,
};

const AGENT2_PROGRESS = {
  totalEligibleNow: 0,
  processedLastRun: 30,
  deferredLastRun: 2,
  remainingEligible: 0,
  stoppedReason: "all_targets_processed",
  lastDurationMs: 540000,
  recentDeferredTargets: [
    { targetUrl: "https://example.com/deferred", reason: "cooldown" },
  ],
};

const AGENT1_PROGRESS = {
  totalEligibleNow: 0,
  processedLastRun: 120,
  deferredLastRun: 3,
  remainingEligible: 0,
  stoppedReason: "all_targets_processed",
  lastDurationMs: 720000,
  lastRunAt: "2026-08-03T03:12:00.000Z",
  recentDeferredTargets: [
    { sourceId: "src-fixture-3", categoryId: null, reason: "rate_limited_429" },
  ],
};

const AGENT1_RUN_SUMMARY = {
  ok: true,
  run: {
    targets: 120,
    candidates: 260,
    inserted: 145,
    skipped: 60,
    failed: 12,
    artifacts: 18,
    createdAt: "2026-08-03T03:10:00.000Z",
    durationMs: 720000,
  },
  items: [
    {
      resultType: "pass",
      targetType: "source",
      sourceId: "src-fixture-4",
      sourceUrl: "https://example.com/feed-source",
      feedUrl: "https://example.com/feed.xml",
      rssUrl: "https://example.com/feed.xml",
      passed: true,
      rssActive: false,
      rateLimited: false,
      inserted: 12,
      candidates: 24,
      skipped: 9,
      urlPolicyRejected: 1,
      failureReason: null,
      createdAt: "2026-08-03T03:10:00.000Z",
    },
    {
      resultType: "rate_limited",
      targetType: "source",
      sourceId: "src-fixture-5",
      sourceUrl: "https://example.com/limited",
      feedUrl: null,
      rssUrl: null,
      passed: false,
      rssActive: false,
      rateLimited: true,
      inserted: 0,
      candidates: 0,
      skipped: 0,
      urlPolicyRejected: 0,
      failureReason: "HTTP 429 — deferred",
      createdAt: "2026-08-03T03:10:00.000Z",
    },
  ],
};

const URL_POLICY_REPORT = {
  evaluated: 0,
  blocked: 0,
  allowed: 0,
  categories: {},
  generatedAt: "2026-08-03T03:45:00.000Z",
};

// ─── Mock handlers ──────────────────────────────────────────────────────────
const MOCK_HANDLERS = {
  "GET /api/auth/user-validate": () => ({ valid: true, isAdmin: true }),
  "GET /api/auth/me": () => ({ ok: true, user: FIXTURE_ADMIN_VIEW }),
  "GET /api/dev/access": () => ({
    ok: true,
    canAccess: true,
    diagnosticsEnabled: true,
    manualPipelineEnabled: true,
    manualArticleDiscoveryEnabled: true,
    destructiveActionsEnabled: true,
    pipelineResetEnabled: true,
    cleanupDeletionEnabled: true,
  }),
  "GET /api/dev/agent-logs": () => ({ ok: true, logs: [] }),
  "GET /api/dev/agent1-run-summary": () => AGENT1_RUN_SUMMARY,
  "GET /api/dev/agent-source-count": () => ({ ok: true, count: 3 }),
  "GET /api/dev/article-discovery-quality": () => ({ ok: true, items: [] }),
  "GET /api/dev/agent2-progress": () => ({ ok: true, progress: AGENT2_PROGRESS }),
  "GET /api/dev/agent1-progress": () => ({ ok: true, progress: AGENT1_PROGRESS }),
  "GET /api/dev/agent3-progress": () => ({ ok: true, progress: AGENT3_PROGRESS }),
  "GET /api/dev/agent3-rejection-diagnostics": () => ({
    ok: true,
    summary: { totalReturned: 0, byKind: {}, httpAccessBlocked: 0, latestOnly: true },
    items: [],
  }),
  "GET /api/dev/article-discovery-headless-queue": () => ({
    ok: true,
    items: [],
    summary: DEFAULT_HEADLESS_SUMMARY,
    view: "active",
    browserFallbackEnabled: true,
  }),
  "GET /api/dev/article-discovery-hard-sources": () => ({ ok: true, report: HARD_SOURCE_REPORT }),
  "GET /api/dev/article-discovery-hard-source-profiles": () => ({
    ok: true,
    profiles: HARD_SOURCE_PROFILES,
    total: HARD_SOURCE_PROFILES.length,
  }),
  "GET /api/dev/agent2-health": () => ({ ok: true, targets: [], total: 0 }),
  "GET /api/dev/daily-pipeline-telemetry": () => ({
    ok: true,
    run: TELEMETRY_RUN,
    stageTimings: TELEMETRY_STAGES,
    batches: [],
    latestNoProgressReason: null,
    pagination: { truncated: false, totalReturned: 0, limit: 200 },
  }),
  "GET /api/dev/notification-and-redirect-diagnostics": () => RELIABILITY_DIAGNOSTICS,
  "GET /api/dev/url-policy-evaluation": () => ({ ok: true, report: URL_POLICY_REPORT }),
  "GET /api/notifications": () => ({ unreadCount: 0 }),
  "GET /api/notifications/status": () => ({
    enabled: false,
    activeCount: 0,
    scheduleSlot: "MORNING",
    allowBreakingNotifications: true,
  }),
};

// URL-based write heuristics (the hard-source-repair handler logs its own
// definitive dryRun=false verdict because the body decides that case).
const DESTRUCTIVE_WRITES = [
  { match: (method, url) => method === "DELETE" && url.startsWith("/api/dev/"), label: "dev DELETE" },
  { match: (method, url) => method === "POST" && url.startsWith("/api/dev/cleanup/"), label: "cleanup write" },
  { match: (method, url) => method === "POST" && url.startsWith("/api/dev/run-article-enrichment"), label: "enrichment write" },
  { match: (method, url) => method === "POST" && url.startsWith("/api/dev/agent2-discovery-profiles/activate"), label: "profile activation write" },
];

async function handleMock(req, res, urlPath, searchParams) {
  const method = req.method || "GET";
  const key = `${method} ${urlPath}`;
  const handler = MOCK_HANDLERS[key];
  if (handler) {
    logRequest(`${method} ${urlPath} -> 200 (mock fixture)`);
    return json(res, 200, handler());
  }

  if (method === "POST" && urlPath === "/api/dev/hard-source-repair") {
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      body = {};
    }
    if (body.dryRun === true) {
      logRequest(`POST /api/dev/hard-source-repair dryRun=true -> 200 (dry-run preview only)`);
      return json(res, 200, {
        ok: true,
        dryRun: true,
        scanned: 5,
        matched: 2,
        updated: 0,
        preview: ["src-fixture-1 (runtime_only)"],
      });
    }
    logRequest(`POST /api/dev/hard-source-repair dryRun=false -> 403 BLOCKED (destructive write refused by fixture)`);
    return json(res, 403, {
      statusCode: 403,
      statusMessage: "Destructive hard-source repair is disabled in the visual verification fixture.",
    });
  }

  if (method === "POST" && urlPath === "/api/dev/notification-workflow-reconcile") {
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      body = {};
    }
    if (body.confirm === true) {
      logRequest(`POST /api/dev/notification-workflow-reconcile confirm=true -> 200 (fixture read-only; no workflow started)`);
      return json(res, 200, {
        changed: false,
        reason: "fixture_read_only",
        marker: MARKERS.find((m) => m.id === body.markerRunId) || null,
      });
    }
    logRequest(`POST /api/dev/notification-workflow-reconcile (inspect) -> 200`);
    return json(res, 200, {
      ok: true,
      readOnly: true,
      markers: body.markerRunId ? MARKERS.filter((m) => m.id === body.markerRunId) : MARKERS,
    });
  }

  // Any other write to the mock: refuse rather than risk a side effect.
  if (method !== "GET" && urlPath.startsWith("/api/")) {
    logRequest(`${method} ${urlPath} -> 403 BLOCKED (unhandled fixture write)`);
    return json(res, 403, { statusCode: 403, statusMessage: "Not available in the visual verification fixture." });
  }

  // Unknown GET under /api → log and give a harmless empty payload.
  if (urlPath.startsWith("/api/")) {
    logRequest(`${method} ${urlPath} -> 200 (generic fixture empty)`);
    return json(res, 200, { ok: true });
  }

  return null;
}

function startMockProxy() {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    const urlPath = url.pathname;
    const method = req.method || "GET";

    if (urlPath === "/__fixture/status") {
      return json(res, 200, {
        ok: true,
        fixture: "admin-browser-fixture",
        nuxtPort: NUXT_PORT,
        fixturePort: FIXTURE_PORT,
        pglitePort: PGLITE_PORT,
        user: FIXTURE_USER.email,
        destructiveWritesBlocked: true,
      });
    }

    if (urlPath === "/__fixture/seed") {
      logRequest(`GET /__fixture/seed -> 200 (session + profile seed)`);
      const seedHtml = `<!doctype html><html><body>
<script>
  localStorage.setItem("nusift_pwa_profile", ${JSON.stringify(JSON.stringify(FIXTURE_ADMIN_VIEW))});
  localStorage.setItem("nusift_preferred_language", "en");
  location.replace("/audit/admin");
</script>
</body></html>`;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": SESSION_COOKIE_HEADERS,
      });
      return res.end(seedHtml);
    }

    // Check for any write that must be blocked (also logged).
    for (const rule of DESTRUCTIVE_WRITES) {
      if (rule.match(method, urlPath)) {
        logRequest(`${method} ${urlPath} -> 403 BLOCKED (${rule.label})`);
      }
    }

    const mockResult = await handleMock(req, res, urlPath, url.searchParams);
    if (mockResult !== null) return;

    // Proxy everything else (document, /_nuxt assets, fonts) to Nuxt dev.
    const nuxtReq = await import("node:http").then(({ request }) => request(
      {
        host: "127.0.0.1",
        port: NUXT_PORT,
        path: req.url,
        method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${NUXT_PORT}`,
          connection: "close",
        },
      },
      (nuxtRes) => {
        const isDocument = urlPath === "/" || (!urlPath.startsWith("/_nuxt") && !urlPath.includes(".") && !urlPath.startsWith("/api/"));
        const headers = { ...nuxtRes.headers };
        if (isDocument) headers["Set-Cookie"] = SESSION_COOKIE_HEADERS;
        res.writeHead(nuxtRes.statusCode || 200, headers);
        nuxtRes.pipe(res);
        logRequest(`${method} ${urlPath} -> ${nuxtRes.statusCode || 200} (proxied to Nuxt)`);
      },
    ));
    nuxtReq.on("error", (err) => {
      logRequest(`${method} ${urlPath} -> 502 (proxy error: ${err.message})`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("fixture proxy could not reach the Nuxt dev server");
      }
    });
    req.pipe(nuxtReq);
  });

  // Forward HMR websockets to the Nuxt dev server.
  server.on("upgrade", (req, socket, head) => {
    const upstream = netConnect(NUXT_PORT, "127.0.0.1", () => {
      upstream.write(head);
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
          Object.entries({ ...req.headers, host: `127.0.0.1:${NUXT_PORT}` })
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
    });
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.on("error", () => {});
    upstream.on("error", () => {});
  });

  server.listen(FIXTURE_PORT, "127.0.0.1", () => {
    log(`Mock API + proxy up on http://127.0.0.1:${FIXTURE_PORT}`);
    log(`Seed the local-only admin session at /__fixture/seed, then it lands on /audit/admin`);
  });
  return server;
}

// ─── Warm-up + lifecycle ────────────────────────────────────────────────────
async function warmUp() {
  // Force Nuxt to compile the admin route with an authenticated cookie so the
  // browser run is not slowed by on-demand compilation.
  const res = await fetch(`http://127.0.0.1:${NUXT_PORT}/audit/admin`, {
    headers: { Cookie: SESSION_COOKIE_HEADERS.map((c) => c.split(";")[0]).join("; ") },
    redirect: "manual",
  });
  log(`warm-up /audit/admin -> ${res.status}`);
}

const pglite = await startPglite();
const nuxtChild = startNuxt();
await waitForNuxt(nuxtChild);
const mockServer = startMockProxy();
await warmUp();

const shutdown = async () => {
  log("shutting down fixture…");
  mockServer.close();
  try {
    nuxtChild.kill("SIGTERM");
  } catch {}
  try {
    await pglite.server.stop();
    await pglite.db.close();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log("fixture ready — point Chrome at http://127.0.0.1:3457/__fixture/seed");
