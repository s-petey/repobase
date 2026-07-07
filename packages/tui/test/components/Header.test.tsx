import { describe, it, expect } from "vitest";
import { testRender } from "@opentui/react/test-utils";
import { Header } from "../../src/components/Header.js";

describe("Header", () => {
  it("renders without crashing", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<Header version="1.0.0" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("displays the app name 'repobase'", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<Header version="1.0.0" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("repobase");
  });

  it("displays the version number", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<Header version="2.5.0" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("v2.5.0");
  });

  it("displays different version numbers correctly", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<Header version="0.0.1" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("v0.0.1");
  });
});
