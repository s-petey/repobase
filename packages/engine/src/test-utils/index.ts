// Mock services
export { makeDefaultGitState, mockGitClientLayer } from "./MockGitClient.js";
export type { MockGitClientState } from "./MockGitClient.js";

export { makeDefaultRepoState, mockRepoStoreLayer } from "./MockRepoStore.js";
export type { MockRepoStoreState } from "./MockRepoStore.js";

export { makeDefaultIndexerState, mockIndexerLayer } from "./MockIndexer.js";
export type { MockIndexerState } from "./MockIndexer.js";

export { makeDefaultCloudSyncState, mockCloudSyncLayer } from "./MockCloudSync.js";
export type { MockCloudSyncState } from "./MockCloudSync.js";

export { makeDefaultEngineState, mockRepobaseEngineLayer } from "./MockRepobaseEngine.js";
export type { MockRepobaseEngineState } from "./MockRepobaseEngine.js";

// Platform-level mocks
export { makeDefaultFsState, mockFileSystem } from "./MockFileSystem.js";
export type { MockFsState } from "./MockFileSystem.js";

export { makeDefaultCmdState, mockCommandExecutor } from "./MockCommandExecutor.js";
export type { MockCommandEntry, MockCommandExecutorState } from "./MockCommandExecutor.js";

// Test utilities
export { makeCapturedConsole, testConsoleLayer } from "./TestConsole.js";
export type { CapturedConsole } from "./TestConsole.js";

export { captureLoggerLayer, silentLoggerLayer } from "./TestLogger.js";

// Composition
export { createMockEngineLayer, makeDefaultMockEngineState } from "./createMockEngineLayer.js";
export type { MockEngineState } from "./createMockEngineLayer.js";
