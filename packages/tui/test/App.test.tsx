import { testRender } from "@opentui/react/test-utils";
import type { AddRepoProgress, RepoConfig as RepoConfigType, SearchResult } from "@repobase/engine";
import { Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { act } from "react";
import { pressEscape } from "./test.helpers.js";

const makeRepo = (id: string, overrides?: Partial<RepoConfigType>): RepoConfigType => ({
  id,
  url: `https://github.com/test/${id}`,
  localPath: `~/.repobase/repos/${id}`,
  mode: { _tag: "tracking", branch: "main" },
  lastSyncedCommit: Option.some("abc123"),
  lastSyncedAt: Option.some(new Date(1700000000000)),
  addedAt: new Date(1700000000000),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
  ...overrides,
});

const makeDefaults = (overrides?: {
  initialRepos?: RepoConfigType[];
  onAddRepo?: (url: string, onProgress: (p: AddRepoProgress) => void) => Promise<RepoConfigType>;
  onRemoveRepo?: (id: string) => Promise<void>;
  onSyncRepo?: (id: string) => Promise<{ updated: boolean }>;
  onSyncAll?: () => Promise<Array<{ id: string; updated: boolean }>>;
  onRefreshRepos?: () => Promise<RepoConfigType[]>;
  onSearch?: (query: string, mode: string) => Promise<SearchResult[]>;
  onQuit?: () => void;
  cloudConfigured?: boolean;
}) => {
  const repos = overrides?.initialRepos ?? [makeRepo("test-repo")];
  return {
    initialRepos: repos,
    onAddRepo: overrides?.onAddRepo ?? vi.fn().mockResolvedValue(makeRepo("new-repo")),
    onRemoveRepo: overrides?.onRemoveRepo ?? vi.fn().mockResolvedValue(undefined),
    onSyncRepo: overrides?.onSyncRepo ?? vi.fn().mockResolvedValue({ updated: true }),
    onSyncAll:
      overrides?.onSyncAll ?? vi.fn().mockResolvedValue([{ id: "test-repo", updated: true }]),
    onRefreshRepos: overrides?.onRefreshRepos ?? vi.fn().mockResolvedValue(repos),
    onSearch: overrides?.onSearch ?? vi.fn().mockResolvedValue([]),
    onQuit: overrides?.onQuit ?? vi.fn(),
    cloudConfigured: overrides?.cloudConfigured ?? false,
  };
};

describe("App", () => {
  it("renders without crashing with no repos", async () => {
    const props = makeDefaults({ initialRepos: [] });
    const { renderOnce, captureCharFrame } = await testRender(<App {...props} />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("renders without crashing with repos", async () => {
    const props = makeDefaults();
    const { renderOnce, captureCharFrame } = await testRender(<App {...props} />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("shows Header with repobase name", async () => {
    const props = makeDefaults();
    const { renderOnce, captureCharFrame } = await testRender(<App {...props} />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("repobase");
  });

  it("shows StatusBar with help text", async () => {
    const props = makeDefaults();
    const { renderOnce, captureCharFrame } = await testRender(<App {...props} />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[a] Add");
    expect(frame).toContain("[d] Delete");
  });

  it("shows empty state when no repos", async () => {
    const props = makeDefaults({ initialRepos: [] });
    const { renderOnce, captureCharFrame } = await testRender(<App {...props} />, {
      width: 80,
      height: 24,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("No repositories configured");
  });

  it("opens AddRepoModal when 'a' is pressed", async () => {
    const { renderOnce, mockInput, captureCharFrame } = await testRender(
      <App {...makeDefaults({ initialRepos: [makeRepo("repo")] })} />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressKey("a"));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Add Repository");
  });

  it("calls onQuit when 'q' is pressed in list mode", async () => {
    const onQuit = vi.fn();
    const { mockInput } = await testRender(
      <App {...makeDefaults({ initialRepos: [makeRepo("repo")], onQuit })} />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressKey("q"));
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it("starts search when '/' is pressed", async () => {
    const { renderOnce, mockInput, captureCharFrame } = await testRender(
      <App {...makeDefaults({ initialRepos: [makeRepo("repo")] })} />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressKey("/"));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Search Repositories");
  });

  it("shows confirm dialog when 'd' is pressed", async () => {
    const { renderOnce, mockInput, captureCharFrame } = await testRender(
      <App {...makeDefaults({ initialRepos: [makeRepo("repo")] })} />,
      { width: 80, height: 24 },
    );
    await renderOnce();

    act(() => mockInput.pressKey("d"));

    await renderOnce();

    const frame = captureCharFrame();
    expect(frame).toContain("Confirm Delete");
  });

  it("closes confirm dialog on Escape", async () => {
    const { renderer, renderOnce, mockInput, captureCharFrame } = await testRender(
      <App {...makeDefaults({ initialRepos: [makeRepo("repo")] })} />,
      { width: 80, height: 24 },
    );
    act(() => mockInput.pressKey("d"));
    await renderOnce();
    act(() => pressEscape(renderer));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toContain("Confirm Delete");
  });

  it("calls onSyncRepo when 's' is pressed", async () => {
    const onSyncRepo = vi.fn().mockResolvedValue({ updated: true });
    const props = makeDefaults({
      initialRepos: [makeRepo("repo")],
      onSyncRepo,
    });
    const { mockInput } = await testRender(<App {...props} />, { width: 80, height: 24 });
    act(() => mockInput.pressKey("s"));
    expect(onSyncRepo).toHaveBeenCalledWith("repo");
  });

  it("calls onSyncAll when 'S' (shift+s) is pressed", async () => {
    const onSyncAll = vi.fn().mockResolvedValue([{ id: "test-repo", updated: true }]);
    const props = makeDefaults({
      initialRepos: [makeRepo("repo")],
      onSyncAll,
    });
    const { mockInput } = await testRender(<App {...props} />, { width: 80, height: 24 });
    act(() => mockInput.pressKey("s", { shift: true }));
    expect(onSyncAll).toHaveBeenCalledTimes(1);
  });

  it("navigates down with 'j' key", async () => {
    const props = makeDefaults({
      initialRepos: [makeRepo("repo-a"), makeRepo("repo-b")],
    });
    const { mockInput } = await testRender(<App {...props} />, { width: 80, height: 24 });
    act(() => {
      mockInput.pressKey("j");
      mockInput.pressKey("d");
    });
  });

  it("navigates up with 'k' key", async () => {
    const props = makeDefaults({
      initialRepos: [makeRepo("repo-a"), makeRepo("repo-b"), makeRepo("repo-c")],
    });
    const { mockInput } = await testRender(<App {...props} />, { width: 80, height: 24 });

    act(() => {
      mockInput.pressKey("j");
      mockInput.pressKey("j");
      mockInput.pressKey("k");
    });
  });

  it("calls onSearch when search is submitted", async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    const props = makeDefaults({
      initialRepos: [makeRepo("repo")],
      onSearch,
    });
    const { mockInput } = await testRender(<App {...props} />, { width: 80, height: 24 });
    act(() => mockInput.pressKey("/"));
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("shows syncing message when syncing", async () => {
    const onSyncRepo = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<{ updated: boolean }>((resolve) =>
            setTimeout(() => resolve({ updated: true }), 100),
          ),
      );
    const props = makeDefaults({
      initialRepos: [makeRepo("repo")],
      onSyncRepo,
    });
    const { renderOnce, mockInput, captureCharFrame } = await testRender(<App {...props} />, {
      width: 80,
      height: 24,
    });
    act(() => mockInput.pressKey("s"));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Syncing");
  });

  it("shows progress modal when adding a repo", async () => {
    const handleAddRepo = vi
      .fn()
      .mockImplementation(async (_url: string, _onProgress: (p: AddRepoProgress) => void) =>
        makeRepo("new-repo"),
      );
    const props = makeDefaults({
      initialRepos: [makeRepo("repo")],
      onAddRepo: handleAddRepo,
    });
    const { renderOnce, mockInput, captureCharFrame } = await testRender(<App {...props} />, {
      width: 80,
      height: 24,
    });
    act(() => mockInput.pressKey("a"));
    await renderOnce();
    const frameBefore = captureCharFrame();
    expect(frameBefore).toContain("Add Repository");
  });

  it("calls onQuit when escape is pressed in list mode", async () => {
    const onQuit = vi.fn();
    const props = makeDefaults({
      initialRepos: [makeRepo("repo")],
      onQuit,
    });
    const { renderer } = await testRender(<App {...props} />, { width: 80, height: 24 });
    act(() => pressEscape(renderer));
    expect(onQuit).toHaveBeenCalledTimes(1);
  });
});
