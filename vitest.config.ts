import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/**/*.test.ts"], exclude: ["test/fork/**"] } },
      { test: { name: "fork", include: ["test/fork/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 } },
    ],
  },
});
