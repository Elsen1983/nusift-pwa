import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Agent 2 Docker runtime context", () => {
  it("copies shared runtime modules imported by server utilities", () => {
    const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile.agent2-dev"), "utf8");

    expect(dockerfile).toContain("COPY server/ ./server/");
    expect(dockerfile).toContain("COPY shared/ ./shared/");
  });
});
