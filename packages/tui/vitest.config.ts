import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    sequence: {
      concurrent: true,
    },
    environment: "node",
  },
});
