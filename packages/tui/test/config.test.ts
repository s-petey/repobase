import { describe, it, expect } from "vitest";
import { featureFlags } from "../src/config.js";

describe("config", () => {
  it("exports featureFlags object", () => {
    expect(featureFlags).toBeDefined();
  });

  it("has cloudSync disabled by default", () => {
    expect(featureFlags.cloudSync).toBe(false);
  });

  it("has mcpServerToggle disabled by default", () => {
    expect(featureFlags.mcpServerToggle).toBe(false);
  });

  it("has readonly feature flags (as const)", () => {
    const flags = featureFlags as Record<string, boolean>;
    expect(flags.cloudSync).toBe(false);
    expect(flags.mcpServerToggle).toBe(false);
  });
});
