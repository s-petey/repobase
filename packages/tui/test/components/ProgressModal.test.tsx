import { describe, it, expect } from "vitest";
import { testRender } from "@opentui/react/test-utils";
import { ProgressModal } from "../../src/components/ProgressModal.js";
import type { AddRepoProgress } from "@repobase/engine";

describe("ProgressModal", () => {
  const cloningProgress: AddRepoProgress = {
    stage: "cloning",
    progress: 25,
    message: "Cloning repository...",
    filesIndexed: undefined,
    totalFiles: undefined,
    currentFile: undefined,
  };

  const indexingProgress: AddRepoProgress = {
    stage: "indexing",
    progress: 65,
    message: "Indexing files...",
    filesIndexed: 150,
    totalFiles: 300,
    currentFile: "src/main.ts",
  };

  const completeProgress: AddRepoProgress = {
    stage: "complete",
    progress: 100,
    message: "Repository added successfully",
    filesIndexed: 300,
    totalFiles: 300,
    currentFile: undefined,
  };

  const errorProgress: AddRepoProgress = {
    stage: "error",
    progress: 0,
    message: "Failed to clone repository",
    filesIndexed: undefined,
    totalFiles: undefined,
    currentFile: undefined,
  };

  it("renders without crashing", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={cloningProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("shows the progress percentage", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={cloningProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("25%");
  });

  it("shows the progress message", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={cloningProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Cloning repository");
  });

  it("shows a progress bar", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={cloningProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[");
    expect(frame).toContain("]");
    expect(frame).toContain("=");
    expect(frame).toContain("-");
  });

  it("shows 'Adding Repository' title", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={cloningProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Adding Repository");
  });

  it("shows 'Please wait' during non-complete stages", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={indexingProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Please wait");
  });

  it("shows 'Continue' when complete", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={completeProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Continue");
  });

  it("shows files indexed count when available", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={indexingProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Files indexed: 150");
  });

  it("does not show files indexed count when undefined", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={cloningProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toContain("Files indexed");
  });

  it("shows error state with correct icon", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={errorProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("x Adding Repository");
    expect(frame).toContain("Failed to clone repository");
  });

  it("shows cloning icon", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={cloningProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("> Adding Repository");
  });

  it("shows indexing icon", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={indexingProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("* Adding Repository");
  });

  it("shows complete icon", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ProgressModal progress={completeProgress} />,
      {
        width: 80,
        height: 24,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("+ Adding Repository");
  });
});
