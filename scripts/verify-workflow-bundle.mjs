import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = process.cwd();
const nodeOutputRoot = join(root, ".output");
const vercelOutputRoot = join(root, ".vercel", "output");
const outputRoot = existsSync(nodeOutputRoot) ? nodeOutputRoot : vercelOutputRoot;
if (!existsSync(outputRoot)) {
  console.error("workflow-bundle-guard: build output is missing; run npm run build first.");
  process.exit(1);
}

const forbidden = [
  ["/var/package.json", "/var/package.json resolution path"],
  ["file:///@workflow/", "absolute Workflow file URL"],
  ["\"/@workflow/", "absolute Workflow import"],
  ["'/@workflow/", "absolute Workflow import"],
  ["from \"playwright\"", "full playwright ESM import"],
  ["from 'playwright'", "full playwright CJS-style import"],
  ["xhr-sync-worker", "xhr-sync-worker dependency marker"],
];

const files = [];
const visit = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) visit(path);
    else if (stat.isFile() && /\.(?:js|mjs|cjs|json)$/.test(name)) files.push(path);
  }
};
visit(outputRoot);

const hits = [];
const workflowRoot = join(root, "node_modules", "@workflow");
const isWithin = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

for (const path of files) {
  const text = readFileSync(path, "utf8");
  for (const [needle, label] of forbidden) {
    if (text.includes(needle)) hits.push(`${label}: ${path}`);
  }

  for (const match of text.matchAll(/["']((?:\.\.\/)+@workflow\/[^"']+)["']/g)) {
    const resolved = resolve(dirname(path), match[1]);
    if (!isWithin(workflowRoot, resolved)) {
      hits.push(`misplaced relative Workflow import (${match[1]}): ${path}`);
    }
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageJson.dependencies?.playwright) {
  hits.push("full playwright package is declared in dependencies");
}

// Browser runtimes must remain behind a regular Nitro/serverless endpoint.
// Bundling either module into a durable step makes playwright-core derive its
// package root from /var/task/index.js and require the nonexistent
// /var/package.json at runtime.
const dailyWorkflowSource = readFileSync(
  join(root, "server", "workflows", "daily-news-pipeline.ts"),
  "utf8",
);
for (const marker of [
  "enrichment-runtime",
  "article-discovery-browser",
  "article-discovery-headless-queue",
  "browser-runtime",
  "playwright-core",
  "@sparticuz/chromium",
]) {
  if (dailyWorkflowSource.includes(marker)) {
    hits.push(`browser runtime marker in durable workflow source: ${marker}`);
  }
}

if (hits.length > 0) {
  console.error("workflow-bundle-guard: FAILED");
  for (const hit of hits) console.error(` - ${hit}`);
  process.exit(1);
}

console.log(`workflow-bundle-guard: PASS (${files.length} generated JS/JSON files inspected)`);
console.log("chromium-bidi: allowed as an explicit playwright-core runtime dependency; unresolved-module errors are not present in this guard.");
