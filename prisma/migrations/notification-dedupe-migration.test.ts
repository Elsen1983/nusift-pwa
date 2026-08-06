import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("notification dedupe migration", () => {
  it("adds a nullable unique key without rewriting legacy rows", () => {
    const sql = readFileSync(resolve(process.cwd(), "prisma/migrations/20260806000000_add_notification_dedupe_key/migration.sql"), "utf8");
    expect(sql).toContain('ADD COLUMN "dedupeKey" TEXT');
    expect(sql).toContain('CREATE UNIQUE INDEX "Notification_dedupeKey_key"');
    expect(sql).not.toMatch(/UPDATE\s+"Notification"/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
  });
});
