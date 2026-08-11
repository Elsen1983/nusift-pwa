import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "prisma/**/*.integration.test.ts",
      "server/utils/news-pipeline/domain-request-governor.integration.test.ts",
    ],
    environment: "node",
    fileParallelism: false,
  },
});
