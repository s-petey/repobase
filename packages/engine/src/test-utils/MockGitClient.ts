import { Effect, Layer } from "effect";
import { GitError } from "../errors.js";
import { GitClient } from "../services/GitClient.js";

export interface MockGitClientState {
  commits: Map<string, string>;
  cloneErrors: string[];
  remoteHead: string;
}

export const makeDefaultGitState = (): MockGitClientState => ({
  commits: new Map(),
  cloneErrors: [],
  remoteHead: "mock-remote-head",
});

export const mockGitClientLayer = (
  state: MockGitClientState = makeDefaultGitState(),
): Layer.Layer<GitClient> =>
  Layer.succeed(
    GitClient,
    GitClient.of({
      clone: (url, path) =>
        state.cloneErrors.includes(url)
          ? Effect.fail(new GitError({ command: "clone", message: `Mock clone error for ${url}` }))
          : Effect.sync(() => {
              state.commits.set(path, "mock-initial-commit");
            }),

      fetch: () => Effect.void,

      getCurrentCommit: (path) => Effect.succeed(state.commits.get(path) ?? "mock-commit-hash"),

      getRemoteHead: (_path, _branch) => Effect.succeed(state.remoteHead),

      resetHard: () => Effect.void,

      checkout: () => Effect.void,

      diffNameStatus: () => Effect.succeed([]),
    }),
  );
