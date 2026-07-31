import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const initialMigration = readFileSync(
  new URL("./20260731134500_add_article_publication_gate/migration.sql", import.meta.url),
  "utf8",
);
const correctiveMigration = readFileSync(
  new URL("./20260731134600_correct_article_publication_gate/migration.sql", import.meta.url),
  "utf8",
);

describe("publication gate migrations", () => {
  it("keeps the already-applied initial migration byte-for-byte immutable", () => {
    expect(createHash("sha256").update(initialMigration).digest("hex")).toBe(
      "c5e0145433cb0de2b24bfef29b1a7fe0a86ab42062217b97589449e641788ecd",
    );
  });

  it("contains a corrective demotion for invalid rows while preserving valid published rows", () => {
    expect(correctiveMigration).toContain('WHERE "publicationStatus" = \'PUBLISHED\'');
    expect(correctiveMigration).toContain('"publicationStatus" = \'CANDIDATE\'');
    expect(correctiveMigration).toContain('"publicationStage" = NULL');
    expect(correctiveMigration).toContain('"publicationReadyAt" = NULL');
    expect(correctiveMigration).toContain("AND NOT (");
    expect(correctiveMigration).toContain('"enrichmentStatus" = \'ENRICHED\'');
    expect(correctiveMigration).toContain("length(regexp_replace(\"bodyText\", '^[[:space:]]+|[[:space:]]+$', '', 'g')) >= 500");
  });
});
