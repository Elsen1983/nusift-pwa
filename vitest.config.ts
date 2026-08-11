import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "prisma/**/*.integration.test.ts",
      "server/utils/news-pipeline/domain-request-governor.integration.test.ts",
    ],
    environment: "node",
  },
});
