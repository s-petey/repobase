import { describe, it, expect, vi } from "vitest";
import { testRender } from "@opentui/react/test-utils";
import { ConfirmDialog } from "../../src/components/ConfirmDialog.js";
import { act } from "react";
import { pressEscape } from "../test.helpers.js";

describe("ConfirmDialog", () => {
  it("renders without crashing", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ConfirmDialog message="Are you sure?" onConfirm={() => {}} onCancel={() => {}} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("displays the confirmation message", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ConfirmDialog message="Delete this repo?" onConfirm={() => {}} onCancel={() => {}} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Delete this repo?");
  });

  it("displays 'Confirm Delete' title", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ConfirmDialog message="Are you sure?" onConfirm={() => {}} onCancel={() => {}} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Confirm Delete");
  });

  it("shows confirm/cancel instructions", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ConfirmDialog message="Are you sure?" onConfirm={() => {}} onCancel={() => {}} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[Enter] Confirm");
    expect(frame).toContain("[Esc] Cancel");
  });

  it("calls onConfirm when Enter is pressed", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { mockInput } = await testRender(
      <ConfirmDialog message="Test" onConfirm={onConfirm} onCancel={onCancel} />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressEnter());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when Escape is pressed", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { renderer } = await testRender(
      <ConfirmDialog message="Test" onConfirm={onConfirm} onCancel={onCancel} />,
      { width: 80, height: 24 },
    );

    act(() => pressEscape(renderer));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
