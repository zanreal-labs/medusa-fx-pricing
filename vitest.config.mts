import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.test.ts",
        "src/**/models/**",
        "src/**/migrations/**",
      ],
      include: ["src/modules/fx-pricing/**/*.ts", "src/workflows/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    environment: "node",
    exclude: ["node_modules", ".medusa", ".cache"],
    include: ["src/**/*.test.ts"],
  },
});
