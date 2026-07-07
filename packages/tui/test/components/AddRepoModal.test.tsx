import { describe, it, expect } from "vitest";
import { testRender } from "@opentui/react/test-utils";
import { AddRepoModal } from "../../src/components/AddRepoModal";

describe("AddRepoModal", () => {
  it("renders without crashing", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <AddRepoModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("shows 'Add Repository' title", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <AddRepoModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Add Repository");
  });

  it("shows placeholder text", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <AddRepoModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("github");
    expect(frame).toContain("owner/repo");
  });

  it("shows confirm/cancel help text", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <AddRepoModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[Enter]═Confirm");
    expect(frame).toContain("[Esc]═Cancel");
  });

  it("shows paste hint", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <AddRepoModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Paste");
  });
});
