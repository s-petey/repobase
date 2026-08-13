import { describe, it, expect } from "vitest";
import { testRender } from "@opentui/react/test-utils";
import { SearchModal } from "../../src/components/SearchModal.js";

describe("SearchModal", () => {
  it("renders without crashing", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 140, height: 36 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("shows 'Search Repositories' title", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 140, height: 36 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Search Repositories");
  });

  it("shows search placeholder text", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 140, height: 36 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Enter search query");
  });

  it("shows all search modes", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 140, height: 36 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Keyword");
    expect(frame).toContain("Semantic");
    expect(frame).toContain("Hybrid");
  });

  it("defaults to hybrid mode (index 2)", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 140, height: 36 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[*] Hybrid");
  });

  it("shows mode description text", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 140, height: 36 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Combined keyword");
  });

  it("shows keyboard shortcuts help", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 140, height: 36 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[Enter] Search");
    expect(frame).toContain("[Tab] Switch focus");
    expect(frame).toContain("[Esc] Cancel");
  });
});
