import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const outputRoot = join(root, ".output");
if (!existsSync(outputRoot)) {
  console.error("workflow-bundle-guard: .output is missing; run npm run build first.");
  process.exit(1);
}

const forbidden = [
  ["/var/package.json", "/var/package.json resolution path"],
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
for (const path of files) {
  const text = readFileSync(path, "utf8");
  for (const [needle, label] of forbidden) {
    if (text.includes(needle)) hits.push(`${label}: ${path}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageJson.dependencies?.playwright) {
  hits.push("full playwright package is declared in dependencies");
}

if (hits.length > 0) {
  console.error("workflow-bundle-guard: FAILED");
  for (const hit of hits) console.error(` - ${hit}`);
  process.exit(1);
}

console.log(`workflow-bundle-guard: PASS (${files.length} generated JS/JSON files inspected)`);
console.log("chromium-bidi: allowed as an explicit playwright-core runtime dependency; unresolved-module errors are not present in this guard.");
