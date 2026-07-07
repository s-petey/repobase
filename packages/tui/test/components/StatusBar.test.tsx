import { describe, it, expect } from "vitest";
import { testRender } from "@opentui/react/test-utils";
import { StatusBar } from "../../src/components/StatusBar.js";

describe("StatusBar", () => {
  it("renders without crashing", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<StatusBar mode="list" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("shows help text in list mode", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<StatusBar mode="list" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[a]");
    expect(frame).toContain("[d]");
    expect(frame).toContain("[s]");
    expect(frame).toContain("[/]");
  });

  it("shows 'Processing...' in syncing mode", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<StatusBar mode="syncing" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Processing");
  });

  it("shows 'Processing...' in adding mode", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<StatusBar mode="adding" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Processing");
  });

  it("shows '[Esc] Back' in results mode", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<StatusBar mode="results" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[Esc] Back");
  });

  it("shows help text for modal modes as empty string (help shown in modal)", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<StatusBar mode="add" />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toContain("[a]");
  });

  it("displays a message when provided", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <StatusBar mode="list" message="Test message" />,
      { width: 180, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Test message");
  });

  it("does not show MCP status when feature flag is off", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <StatusBar mode="list" mcpServerRunning={true} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toContain("MCP");
  });

  it("does not show cloud status when feature flag is off", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <StatusBar mode="list" cloudConfigured={true} cloudPendingCount={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toContain("Cloud");
  });
});
