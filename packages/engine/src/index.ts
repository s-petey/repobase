// Schemas
export {
  type TrackingMode,
  type PinnedMode,
  type RepoMode,
  type RepoConfig,
  type RepoStoreData,
  type CloudConfig,
  type SyncManifestFile,
  type SyncManifest,
  type FileChange,
  type IndexPlanFile,
  type IndexPlan,
  type IndexSummary,
  type IndexingProgress,
  type SearchMode,
  type SearchResult,
  type AddRepoStage,
  type AddRepoProgress,
  type SyncResult,
  TrackingMode as TrackingModeSchema,
  PinnedMode as PinnedModeSchema,
  RepoMode as RepoModeSchema,
  RepoConfig as RepoConfigSchema,
  RepoStoreData as RepoStoreDataSchema,
  CloudConfig as CloudConfigSchema,
  SyncManifestFile as SyncManifestFileSchema,
  SyncManifest as SyncManifestSchema,
  FileChange as FileChangeSchema,
  IndexPlanFile as IndexPlanFileSchema,
  IndexPlan as IndexPlanSchema,
  IndexSummary as IndexSummarySchema,
  IndexingProgress as IndexingProgressSchema,
  SearchMode as SearchModeSchema,
  SearchResult as SearchResultSchema,
  AddRepoStage as AddRepoStageSchema,
  AddRepoProgress as AddRepoProgressSchema,
  SyncResult as SyncResultSchema
} from "./schemas.js"

// Utils
export {
  deriveRepoId,
  extractRepoParts,
  migratedRepoId,
  repoNames,
  splitRepoPath,
  trackingMode,
  pinnedMode
} from "./utils.js"
export { CURRENT_INDEX_FORMAT, needsReindex } from "./indexFormat.js"

// Errors
export {
  GitError,
  StoreError,
  IndexError,
  SearchError,
  CloudError,
  CloudNotConfiguredError,
  RepoNotFoundError,
  RepoAlreadyExistsError,
  FileNotFoundError,
  InvalidPatternError,
  type EngineError
} from "./errors.js"

// Services
export { GitClient, type GitClientService } from "./services/GitClient.js"
export { RepoStore, type RepoStoreService } from "./services/RepoStore.js"
export {
  Indexer,
  type IndexerService,
  type SearchOptions,
  type IndexOptions,
  initialIndexingProgress,
  type FileInfo,
  type FileContent,
  type GrepMatch,
  type GrepResult,
  type ListFilesOptions,
  type GlobOptions,
  type ReadFileOptions,
  type GrepOptions
} from "./services/Indexer.js"
export {
  RepobaseEngine,
  type RepobaseEngineService,
  type AddRepoOptions,
  initialProgress
} from "./services/RepobaseEngine.js"
export {
  CloudSync,
  type CloudSyncService,
  type PushResult,
  type PullResult,
  type SyncStatus,
  type CloudConfigInput
} from "./services/CloudSync.js"

// Worker limits
export {
  MAX_WORKERS_ENV,
  MAX_INDEXING_ENV,
  resolveWorkerCount,
  hostWorkerCount,
  resolveIndexingConcurrency,
  hostIndexingConcurrency,
  splitPools,
  ONNX_THREADS_PER_WORKER,
  type WorkerCount,
  type WorkerCountInput,
  type PoolSizes
} from "./worker/limits.js"

// Job step errors
export {
  StepError,
  GitFailureReason,
  PlanIndexPhase,
  IndexBatchPhase,
  RepoAlreadyAddedError,
  RepoMissingError,
  CloneFailedError,
  ResolveHeadFailedError,
  SaveConfigFailedError,
  FetchFailedError,
  RemoteBranchMissingError,
  DiffFailedError,
  ResetFailedError,
  PlanIndexFailedError,
  DeleteRemovedFailedError,
  IndexBatchFailedError,
  EmbedderLoadFailedError,
  FinalizeFtsFailedError,
  UpdateStoreFailedError,
  WorkerCrashedError,
  UnexpectedStepError,
  isRetryable,
  classifyGitFailure,
  cloneFailed,
  fetchFailed,
  remoteHeadFailed,
  workerCrashed,
  formatStepError,
  type StepErrorDisplay
} from "./jobs/errors.js"

// Jobs
export {
  Job,
  AddRepoJob,
  SyncRepoJob,
  ReindexRepoJob,
  AddRepoPayload,
  SyncRepoPayload,
  JobStatus,
  Step,
  StepStatus,
  StepRunsOn,
  makeJobId,
  type JobKind
} from "./jobs/Job.js"
export {
  JobStore,
  type JobStoreService,
  defaultJobsDir,
  layer as JobStoreLayer,
  layerWith as JobStoreLayerWith,
  layerMemory as JobStoreLayerMemory
} from "./jobs/JobStore.js"
export {
  JobRunner,
  type JobRunnerService,
  type JobRunnerError,
  JobAlreadyRunningError,
  JobNotFoundError,
  JobNotRetryableError,
  type JobDefinition,
  type JobDefinitions,
  type StepDefinition,
  type FanOutDefinition,
  type StepContext,
  type OutputSchema,
  step,
  fanOut,
  fanOutKey,
  layer as JobRunnerLayer
} from "./jobs/JobRunner.js"
export {
  JobProgress,
  type JobProgressService,
  type FileProgress,
  layer as JobProgressLayer
} from "./jobs/JobProgress.js"
export {
  makeJobDefinitions,
  defaultDefinitionsConfig,
  type DefinitionsConfig,
  type JobDefinitionsServices
} from "./jobs/definitions.js"

// Worker pool
export {
  StepRpcs,
  Clone,
  ResolveHead,
  PlanFullIndex,
  DeleteRemoved,
  IndexBatch,
  FinalizeIndex,
  PlanSummary,
  IndexBatchEvent,
  Search
} from "./worker/rpcs.js"
export {
  WorkerClient,
  layerWorkerPool,
  QueryClient,
  layerQueryPool,
  IndexingClient,
  layerIndexingPool,
  layerQueryFromIndexingPool
} from "./worker/client.js"
export { runWorker } from "./worker/server.js"

// Logging
export {
  logPath,
  fileLoggerLayer,
  addFileLoggerLayer,
  silentLoggerLayer
} from "./file-logger.js"

export { telemetryLayer } from "./telemetry.js"

// Layers
export { layer as GitClientLayer } from "./services/GitClient.js"
export { layer as RepoStoreLayer } from "./services/RepoStore.js"
export { layer as IndexerLayer, layerWith as IndexerLayerWith } from "./services/Indexer.js"
export { layer as RepobaseEngineLayer } from "./services/RepobaseEngine.js"
export { layer as CloudSyncLayer } from "./services/CloudSync.js"

// Layer composition for Bun
import { Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { layer as GitClientLayer } from "./services/GitClient.js"
import { layer as RepoStoreLayer } from "./services/RepoStore.js"
import { layer as IndexerLayer } from "./services/Indexer.js"
import { layer as RepobaseEngineLayer } from "./services/RepobaseEngine.js"
import { layer as CloudSyncLayer } from "./services/CloudSync.js"

/**
 * Platform dependencies for Bun
 */
export const PlatformLive = BunServices.layer

/**
 * GitClient layer with Bun platform
 */
export const GitClientLive = GitClientLayer.pipe(Layer.provide(PlatformLive))

/**
 * RepoStore layer with Bun platform
 */
export const RepoStoreLive = RepoStoreLayer.pipe(Layer.provide(PlatformLive))

/**
 * Indexer layer with Bun platform
 */
export const IndexerLive = IndexerLayer.pipe(Layer.provide(PlatformLive))

/**
 * CloudSync layer with Bun platform and RepoStore
 */
export const CloudSyncLive = CloudSyncLayer.pipe(
  Layer.provide(Layer.mergeAll(RepoStoreLayer, PlatformLive))
)

/**
 * RepobaseEngine layer with all dependencies
 * Composes all required layers and provides the platform at the end
 */
export const RepobaseEngineLive = RepobaseEngineLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      GitClientLayer,
      RepoStoreLayer,
      IndexerLayer,
      PlatformLive
    )
  )
)
