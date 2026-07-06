import { Console, Layer } from "effect";
import { CloudSync } from "../services/CloudSync.js";
import { GitClient } from "../services/GitClient.js";
import { Indexer } from "../services/Indexer.js";
import { RepobaseEngine } from "../services/RepobaseEngine.js";
import { RepoStore } from "../services/RepoStore.js";
import type { MockCloudSyncState } from "./MockCloudSync.js";
import { makeDefaultCloudSyncState, mockCloudSyncLayer } from "./MockCloudSync.js";
import type { MockGitClientState } from "./MockGitClient.js";
import { makeDefaultGitState, mockGitClientLayer } from "./MockGitClient.js";
import type { MockIndexerState } from "./MockIndexer.js";
import { makeDefaultIndexerState, mockIndexerLayer } from "./MockIndexer.js";
import type { MockRepobaseEngineState } from "./MockRepobaseEngine.js";
import { makeDefaultEngineState, mockRepobaseEngineLayer } from "./MockRepobaseEngine.js";
import type { MockRepoStoreState } from "./MockRepoStore.js";
import { makeDefaultRepoState, mockRepoStoreLayer } from "./MockRepoStore.js";
import type { CapturedConsole } from "./TestConsole.js";
import { makeCapturedConsole, testConsoleLayer } from "./TestConsole.js";
import { silentLoggerLayer } from "./TestLogger.js";

export interface MockEngineState {
  git: MockGitClientState;
  repoStore: MockRepoStoreState;
  indexer: MockIndexerState;
  cloudSync: MockCloudSyncState;
  engine: MockRepobaseEngineState;
  console: CapturedConsole;
}

export const makeDefaultMockEngineState = (): MockEngineState => ({
  git: makeDefaultGitState(),
  repoStore: makeDefaultRepoState(),
  indexer: makeDefaultIndexerState(),
  cloudSync: makeDefaultCloudSyncState(),
  engine: makeDefaultEngineState(),
  console: makeCapturedConsole(),
});

export const createMockEngineLayer = (
  state: MockEngineState = makeDefaultMockEngineState(),
): Layer.Layer<GitClient | RepoStore | Indexer | CloudSync | RepobaseEngine | Console.Console> =>
  Layer.mergeAll(
    mockGitClientLayer(state.git),
    mockRepoStoreLayer(state.repoStore),
    mockIndexerLayer(state.indexer),
    mockCloudSyncLayer(state.cloudSync),
    mockRepobaseEngineLayer(state.engine),
    testConsoleLayer(state.console),
    silentLoggerLayer,
  );
