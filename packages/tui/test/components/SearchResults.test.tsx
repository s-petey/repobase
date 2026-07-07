import { testRender } from "@opentui/react/test-utils";
import type { SearchResult } from "@repobase/engine";
import { Option } from "effect";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { SearchResults } from "../../src/components/SearchResults.js";
import { pressEscape } from "../test.helpers.js";

const makeResult = (overrides?: Partial<SearchResult>): SearchResult => ({
  repo: "test-repo",
  path: "src/index.ts",
  score: 0.95,
  snippet: Option.some("function hello() { return 'world' }"),
  filename: overrides?.filename ?? "test_file.md",
  ...overrides,
});

const makeResultWithSnippet = (
  repo: string,
  path: string,
  score: number,
  snippetText?: string,
): SearchResult => ({
  repo,
  path,
  score,
  filename: "",
  snippet: snippetText ? Option.some(snippetText) : Option.none(),
});

describe("SearchResults", () => {
  const noop = () => {};

  it("renders without crashing", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={[]}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("shows the search query and mode", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="hello world"
        mode="keyword"
        results={[]}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("hello world");
    expect(frame).toContain("Keyword");
  });

  it("shows hybrid mode label", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={[]}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Hybrid");
  });

  it("shows semantic mode label", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="semantic"
        results={[]}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Semantic");
  });

  it("shows 'No results found' when empty", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={[]}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("No results found");
  });

  it("shows back instruction when empty", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={[]}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[Esc]");
    expect(frame).toContain("[q]");
  });

  it("shows result count", async () => {
    const results = [makeResult()];
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={results}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("1 result");
  });

  it("shows plural result count", async () => {
    const results = [makeResult(), makeResult({ path: "src/bar.ts" })];
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={results}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("2 results");
  });

  it("shows result repo and path", async () => {
    const results = [makeResultWithSnippet("my-repo", "src/main.ts", 0.85)];
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="keyword"
        results={results}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("my-repo");
    expect(frame).toContain("src/main.ts");
  });

  it("shows score percentage", async () => {
    const results = [makeResultWithSnippet("repo", "file.ts", 0.75)];
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="keyword"
        results={results}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("75%");
  });

  it("shows snippet for selected result", async () => {
    const results = [makeResultWithSnippet("repo", "file.ts", 0.9, "const x = 1")];
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="keyword"
        results={results}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("const x = 1");
  });

  it("shows navigation help in footer", async () => {
    const results = [makeResult()];
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={results}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[Up/k]");
    expect(frame).toContain("[Down/j]");
    expect(frame).toContain("[Esc/q]");
  });

  it("navigates down with arrow key", async () => {
    const onSelectIndex = vi.fn();
    const results = [
      makeResultWithSnippet("repo", "a.ts", 0.5),
      makeResultWithSnippet("repo", "b.ts", 0.6),
    ];
    const { mockInput } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={results}
        selectedIndex={0}
        onSelectIndex={onSelectIndex}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressArrow("down"));
    expect(onSelectIndex).toHaveBeenCalledWith(1);
  });

  it("navigates up with arrow key", async () => {
    const onSelectIndex = vi.fn();
    const results = [
      makeResultWithSnippet("repo", "a.ts", 0.5),
      makeResultWithSnippet("repo", "b.ts", 0.6),
    ];
    const { mockInput } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={results}
        selectedIndex={1}
        onSelectIndex={onSelectIndex}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressArrow("up"));
    expect(onSelectIndex).toHaveBeenCalledWith(0);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const { captureCharFrame, renderer, renderOnce } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={[]}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={onClose}
      />,
      { width: 80, height: 24 },
    );

    await renderOnce();

    const frame = captureCharFrame();

    expect(frame).toContain("Press [Esc] or [q]");

    act(() => pressEscape(renderer));

    expect(frame).not.toContain("Confirm Delete");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on 'q' key", async () => {
    const onClose = vi.fn();
    const { mockInput } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={[]}
        selectedIndex={0}
        onSelectIndex={noop}
        onClose={onClose}
      />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressKey("q"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not navigate above first result", async () => {
    const onSelectIndex = vi.fn();
    const results = [makeResultWithSnippet("repo", "a.ts", 0.5)];
    const { mockInput } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={results}
        selectedIndex={0}
        onSelectIndex={onSelectIndex}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressArrow("up"));
    expect(onSelectIndex).toHaveBeenCalledWith(0);
  });

  it("does not navigate below last result", async () => {
    const onSelectIndex = vi.fn();
    const results = [makeResultWithSnippet("repo", "a.ts", 0.5)];
    const { mockInput } = await testRender(
      <SearchResults
        query="test"
        mode="hybrid"
        results={results}
        selectedIndex={0}
        onSelectIndex={onSelectIndex}
        onClose={noop}
      />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressArrow("down"));
    expect(onSelectIndex).toHaveBeenCalledWith(0);
  });
});
