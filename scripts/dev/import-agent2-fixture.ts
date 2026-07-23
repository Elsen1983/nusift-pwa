import { promises as fs } from "node:fs";

const fileArg = process.argv.slice(2).find((arg) => arg.startsWith("--file="));
const file = fileArg?.slice("--file=".length);

if (!file) {
  console.error("Usage: npx tsx scripts/dev/import-agent2-fixture.ts --file=data/fixtures/agent2/<slug>.json");
  process.exit(1);
}

const fixture = JSON.parse(await fs.readFile(file, "utf8"));

console.log(JSON.stringify({
  ok: true,
  imported: false,
  reason: "Import is intentionally read-only in this first diagnostic pass. Use the exported fixture as reviewable input before adding DB writes.",
  schemaVersion: fixture.schemaVersion || null,
  target: fixture.target || null,
  sourceId: fixture.source?.id || null,
  categoryId: fixture.category?.id || null,
  artifacts: Array.isArray(fixture.artifacts) ? fixture.artifacts.length : 0,
  articles: Array.isArray(fixture.articles) ? fixture.articles.length : 0,
}, null, 2));
