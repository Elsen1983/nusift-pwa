import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./20260812160000_define_article_identity_contract/migration.sql", import.meta.url),
  "utf8",
);

describe("Article identity migration", () => {
  it("adds canonical identity, scopes GUIDs, and makes content hash non-unique without deleting data", () => {
    expect(migration).toContain('ADD COLUMN "canonicalIdentity" TEXT');
    expect(migration).toContain('DROP INDEX "Article_rssGuid_key"');
    expect(migration).toContain('DROP INDEX "Article_contentHash_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "Article_canonicalIdentity_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "Article_sourceId_rssGuid_key"');
    expect(migration).toContain('CREATE INDEX "Article_contentHash_idx"');
    expect(migration).toContain("HAVING count(*) = 1");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"Article"/i);
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
  });
});
