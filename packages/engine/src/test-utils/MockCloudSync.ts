import { Effect, Layer, Option } from "effect";
import { CloudError, CloudNotConfiguredError } from "../errors.js";
import type { CloudConfig } from "../schemas.js";
import type {
  CloudConfigInput,
  PullResult,
  PushResult,
  SyncStatus,
} from "../services/CloudSync.js";
import { CloudSync } from "../services/CloudSync.js";

export interface MockCloudSyncState {
  configured: boolean;
  config: CloudConfig | null;
  cloudEnabledRepos: Set<string>;
  pushResults: PushResult[];
  pullResult: PullResult;
  syncStatus: SyncStatus;
}

export const makeDefaultCloudSyncState = (): MockCloudSyncState => ({
  configured: false,
  config: null,
  cloudEnabledRepos: new Set(),
  pushResults: [],
  pullResult: { filesDownloaded: 0, durationMs: 0 },
  syncStatus: {
    repoId: "mock-repo",
    inSync: true,
    localCommit: Option.some("abc123"),
    cloudCommit: Option.some("abc123"),
    lastPushedAt: Option.some(new Date()),
  },
});

export const mockCloudSyncLayer = (
  state: MockCloudSyncState = makeDefaultCloudSyncState(),
): Layer.Layer<CloudSync> =>
  Layer.succeed(
    CloudSync,
    CloudSync.of({
      configure: (config: CloudConfigInput) =>
        Effect.sync(() => {
          state.configured = true;
          state.config = {
            userId: config.userId,
            apiKey: Option.some(config.apiKey),
            endpoint: config.endpoint,
          };
        }),

      getConfig: () =>
        state.configured && state.config
          ? Effect.succeed(state.config)
          : Effect.fail(new CloudNotConfiguredError()),

      clearConfig: () =>
        Effect.sync(() => {
          state.configured = false;
          state.config = null;
        }),

      isConfigured: () => Effect.succeed(state.configured),

      enableRepo: (repoId: string) =>
        Effect.sync(() => {
          state.cloudEnabledRepos.add(repoId);
        }),

      disableRepo: (repoId: string) =>
        Effect.sync(() => {
          state.cloudEnabledRepos.delete(repoId);
        }),

      push: (repoId: string) =>
        state.configured
          ? Effect.sync(() => ({
              repoId,
              filesUploaded: 5,
              filesSkipped: 0,
              durationMs: 200,
            }))
          : Effect.fail(new CloudNotConfiguredError()),

      pushAll: () =>
        state.configured
          ? Effect.succeed(state.pushResults)
          : Effect.fail(new CloudNotConfiguredError()),

      pull: () =>
        state.configured
          ? Effect.succeed(state.pullResult)
          : Effect.fail(new CloudNotConfiguredError()),

      getStatus: (_repoId: string) =>
        state.configured
          ? Effect.succeed(state.syncStatus)
          : Effect.fail(new CloudError({ operation: "getStatus", message: "Testing Error" })),

      listCloudEnabled: () => Effect.succeed([]),
    }),
  );
