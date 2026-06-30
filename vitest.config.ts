import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts"],
    environment: "node",
  },
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
      },
    },
  },
});
