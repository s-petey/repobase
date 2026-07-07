import { describe, it, expect } from "vitest";
import { testRender } from "@opentui/react/test-utils";
import { RepoList } from "../../src/components/RepoList.js";
import type { RepoConfig } from "@repobase/engine";
import { Option } from "effect";

const makeTrackingRepo = (id: string, overrides?: Partial<RepoConfig>): RepoConfig => ({
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

const makePinnedRepo = (id: string): RepoConfig => ({
  id,
  url: `https://github.com/test/${id}`,
  localPath: `~/.repobase/repos/${id}`,
  mode: { _tag: "pinned", ref: "v1.0.0" },
  lastSyncedCommit: Option.none(),
  lastSyncedAt: Option.none(),
  addedAt: new Date(1700000000000),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
});

describe("RepoList", () => {
  it("renders without crashing when empty", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={[]} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toBeTruthy();
  });

  it("shows empty state message when no repos", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={[]} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("No repositories configured");
  });

  it("shows prompt to add a repo when empty", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={[]} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[a]");
  });

  it("renders a single repo", async () => {
    const repos = [makeTrackingRepo("test-repo")];
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={repos} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("test-repo");
    expect(frame).toContain("tracking: main");
  });

  it("renders multiple repos", async () => {
    const repos = [
      makeTrackingRepo("repo-a"),
      makeTrackingRepo("repo-b"),
      makeTrackingRepo("repo-c"),
    ];
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={repos} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("repo-a");
    expect(frame).toContain("repo-b");
    expect(frame).toContain("repo-c");
  });

  it("shows selected repo with '>' prefix", async () => {
    const repos = [makeTrackingRepo("first"), makeTrackingRepo("second")];
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={repos} selectedIndex={1} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain(">");
  });

  it("shows pinned mode repos correctly", async () => {
    const repos = [makePinnedRepo("pinned-repo")];
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={repos} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("pinned-repo");
    expect(frame).toContain("pinned: v1.0.0");
    expect(frame).toContain("pinned");
  });

  it("shows synced status for tracked repos with lastSyncedCommit", async () => {
    const repos = [makeTrackingRepo("synced-repo")];
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={repos} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("synced");
  });

  it("shows pending status for repos without lastSyncedCommit", async () => {
    const repos = [makeTrackingRepo("pending-repo", { lastSyncedCommit: Option.none() })];
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={repos} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("pending");
  });

  it("shows cloud indicator for cloud-enabled repos", async () => {
    const repos = [
      makeTrackingRepo("cloud-repo", { cloudEnabled: true, lastPushedCommit: Option.none() }),
    ];
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={repos} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[C^]");
  });

  it("shows repo count in header", async () => {
    const repos = [makeTrackingRepo("one"), makeTrackingRepo("two"), makeTrackingRepo("three")];
    const { renderOnce, captureCharFrame } = await testRender(
      <RepoList repos={repos} selectedIndex={0} />,
      { width: 80, height: 24 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Repositories (3)");
  });
});
