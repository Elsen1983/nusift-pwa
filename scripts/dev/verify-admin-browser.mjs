#!/usr/bin/env node
/**
 * Local-only authenticated admin browser verification driver.
 *
 * Drives the REAL /audit/admin page through the admin-browser-fixture mock
 * proxy (http://127.0.0.1:3457) at desktop and 390px mobile widths, verifies
 * every required panel and modal, captures browser console output, checks for
 * horizontal overflow, and saves screenshots to browser-verify/.
 *
 * Requires: fixture running (NUSIFT_ADMIN_FIXTURE=1 node
 * scripts/dev/admin-browser-fixture.mjs) and Google Chrome installed.
 */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "browser-verify");
mkdirSync(OUT, { recursive: true });

const BASE = "http://127.0.0.1:3457";
const SEED = `${BASE}/__fixture/seed`;
const ADMIN = `${BASE}/audit/admin`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasText = (text, needle) => text.toLowerCase().includes(needle.toLowerCase());

const consoleMessages = [];
const pageErrors = [];
const requestFailures = [];

const results = [];
const record = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function runAtViewport(browser, viewport, label) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  page.on("console", (msg) => {
    consoleMessages.push({ label, type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => pageErrors.push({ label, message: String(err) }));
  page.on("requestfailed", (req) =>
    requestFailures.push({
      label,
      url: req.url(),
      failure: req.failure()?.errorText || "unknown",
    }),
  );

  // Seed the local-only admin session + profile, then land on /audit/admin.
  await page.goto(SEED, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForURL((u) => u.pathname === "/audit/admin", { timeout: 90_000 });

  // Wait for the admin shell to hydrate and panels to populate.
  await page.waitForSelector("text=NuSift Admin Console", { timeout: 90_000 });
  await page.waitForFunction(
    () => !document.body.innerText.includes("Admin access required"),
    { timeout: 90_000 },
  );

  const heading = await page.locator("h1").first().innerText().catch(() => "");
  record(`${label}: page shows NuSift Admin Console heading`, heading.includes("NuSift Admin Console"), heading.trim());

  // Wait for the Daily pipeline telemetry + Agent 3 completion panel.
  await page.waitForSelector("text=Daily pipeline telemetry", { timeout: 60_000 }).catch(() => {});
  await page.waitForFunction(
    () => /agent 3 completion/i.test(document.body.innerText),
    { timeout: 60_000 },
  ).catch(() => {});
  const completionText = await page.evaluate(() => {
    const t = document.body.innerText;
    const panel = /agent 3 completion/i.test(t);
    const drained = /current orchestration drained/i.test(t);
    const counts = /future-run eligible/i.test(t) && /future-run retryable/i.test(t);
    return panel && drained && counts
      ? "Agent 3 completion panel rendered (current orchestration drained, future-run counts)"
      : panel
        ? "Agent 3 completion panel present but counts missing"
        : "MISSING";
  });
  record(`${label}: Agent 3 completion panel`, completionText !== "MISSING" && !completionText.includes("counts missing"), completionText);

  // Reliability diagnostics: click Refresh and verify the panels.
  const reliabilityRefresh = page.getByRole("button", { name: "Refresh" }).filter({ hasText: "" }).last();
  await page.locator("section", { hasText: "Reliability diagnostics" }).getByRole("button", { name: "Refresh" }).click({ timeout: 30_000 }).catch(() => {});
  await sleep(2500);
  const reliabilityText = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      marker: /notification workflow/i.test(t) && t.includes("NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"),
      rss: /rss-owned \/ browser outcomes/i.test(t) && /productive skip/i.test(t),
      browser: /browser runtime statuses/i.test(t) && /headless_ok/i.test(t),
      redirect: /per-redirect retry state/i.test(t) && /redirect retry artifacts|http_429|attempts/i.test(t),
      evidence: /retry-safe/i.test(t) && /first slot attempted/i.test(t),
    };
  });
  record(`${label}: notification workflow markers render`, reliabilityText.marker, JSON.stringify(reliabilityText));
  record(`${label}: RSS ownership diagnostics`, reliabilityText.rss);
  record(`${label}: browser runtime diagnostics`, reliabilityText.browser);
  record(`${label}: redirect terminal-state diagnostics`, reliabilityText.redirect);
  record(`${label}: retry-safety evidence row`, reliabilityText.evidence);

  // Reconciliation modal: open + close.
  const ackButton = page.getByRole("button", { name: "Acknowledge reconciliation" }).first();
  const hasAck = (await ackButton.count()) > 0;
  if (hasAck) {
    await ackButton.click({ timeout: 15_000 });
    await sleep(600);
    const modalOpen = await page.evaluate(() => document.body.innerText.includes("Close uncertain notification launch?"));
    record(`${label}: reconciliation modal renders`, modalOpen);
    if (modalOpen) {
      await page.getByRole("button", { name: "Cancel" }).last().click({ timeout: 15_000 }).catch(() => {});
      await sleep(400);
      const modalClosed = await page.evaluate(() => !document.body.innerText.includes("Close uncertain notification launch?"));
      record(`${label}: reconciliation modal closes`, modalClosed);
    } else {
      record(`${label}: reconciliation modal closes`, false, "modal did not open");
    }
  } else {
    record(`${label}: reconciliation modal renders`, false, "no Acknowledge reconciliation button");
  }

  // Hard-source repair: dry-run preview + confirmation modal open/close.
  const repairSection = page.locator("section", { hasText: "Runtime-only hard-source repair" });
  await repairSection.getByRole("button", { name: "Preview dry-run" }).click({ timeout: 20_000 }).catch(() => {});
  await sleep(1200);
  const previewText = await page.evaluate(() => document.body.innerText.match(/Dry-run: scanned \d+, matched \d+, updated \d+/)?.[0] || "");
  record(`${label}: hard-source repair preview (dry-run)`, previewText.startsWith("Dry-run: scanned"), previewText);

  const tokenInput = repairSection.locator("input").first();
  await tokenInput.fill("REPAIR_RUNTIME_ONLY_HARD_SOURCE_PROFILES", { timeout: 15_000 }).catch(() => {});
  await repairSection.getByRole("button", { name: "Confirm repair" }).click({ timeout: 15_000 }).catch(() => {});
  await sleep(600);
  const repairModalOpen = await page.evaluate(() => document.body.innerText.includes("Confirm runtime-only repair"));
  record(`${label}: hard-source destructive confirmation modal renders`, repairModalOpen);
  if (repairModalOpen) {
    await page.getByRole("button", { name: "Cancel" }).last().click({ timeout: 15_000 }).catch(() => {});
    await sleep(400);
    const repairModalClosed = await page.evaluate(() => !document.body.innerText.includes("Confirm runtime-only repair"));
    record(`${label}: hard-source destructive confirmation modal closes`, repairModalClosed);
  }

  // Pre-existing admin sections still present.
  const sections = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return {
      agent1: t.includes("agent 1 - rss ingest"),
      agent2: t.includes("agent 2 - discovery and headless queue"),
      agent3: t.includes("agent 3"),
      hardSources: t.includes("agent 2 hard sources"),
      hardSourceProfiles: t.includes("hard-source profiles"),
      headlessQueue: t.includes("agent 2 headless queue"),
      telemetry: t.includes("daily pipeline telemetry"),
    };
  });
  const missing = Object.entries(sections).filter(([, v]) => !v).map(([k]) => k);
  record(`${label}: all pre-existing admin sections present`, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : Object.values(sections).filter(Boolean).length + " sections");

  // Horizontal overflow check.
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    inner: window.innerWidth,
  }));
  record(
    `${label}: no horizontal overflow`,
    overflow.doc <= overflow.inner && overflow.body <= overflow.inner,
    `scrollWidth ${overflow.doc}/${overflow.body} vs innerWidth ${overflow.inner}`,
  );

  // Screenshots.
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await page.screenshot({ path: join(OUT, `admin-${label === "desktop" ? "desktop" : "mobile"}.png`) });
  if (label === "desktop") {
    await page.screenshot({ path: join(OUT, "admin-desktop-full.png"), fullPage: true });
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("section")).find((s) => s.innerText.includes("Daily pipeline telemetry"));
      if (el) el.scrollIntoView({ block: "start" });
    });
    await sleep(400);
    await page.screenshot({ path: join(OUT, "admin-desktop-telemetry.png") });
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("section")).find((s) => s.innerText.includes("Reliability diagnostics"));
      if (el) el.scrollIntoView({ block: "start" });
    });
    await sleep(400);
    await page.screenshot({ path: join(OUT, "admin-desktop-reliability.png") });
  } else {
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("section")).find((s) => s.innerText.includes("Reliability diagnostics"));
      if (el) el.scrollIntoView({ block: "start" });
    });
    await sleep(400);
    await page.screenshot({ path: join(OUT, "admin-mobile-reliability.png") });
  }

  await context.close();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await runAtViewport(browser, { width: 1280, height: 900 }, "desktop");
  await runAtViewport(browser, { width: 390, height: 844 }, "mobile");
} finally {
  await browser.close();
}

// ─── Report ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log("\n===== VERIFICATION SUMMARY =====");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
console.log(`\nTotal: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);

console.log("\n===== CONSOLE MESSAGES =====");
const seen = new Set();
for (const m of consoleMessages) {
  const key = `${m.label}|${m.type}|${m.text}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`[${m.label}] ${m.type}: ${m.text.slice(0, 300)}`);
}
console.log("\n===== PAGE ERRORS =====");
for (const e of pageErrors) console.log(`[${e.label}] ${e.message.slice(0, 300)}`);
console.log("\n===== REQUEST FAILURES =====");
for (const f of requestFailures) console.log(`[${f.label}] ${f.failure}: ${f.url.slice(0, 200)}`);

process.exit(failed.length > 0 ? 2 : 0);
