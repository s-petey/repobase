# E2E Integration Test Plan for Repobase (CLI + TUI + MCP Server)

## Objective

Verify that the CLI, TUI, and MCP Server packages correctly compose, wire up, and invoke all Effect engine services (`GitClient`, `RepoStore`, `Indexer`, `RepobaseEngine`, `CloudSync`, `FileSystem`, `CommandExecutor`) using their respective mock layers — ensuring no miswired dependencies, correct error propagation, and complete command/tool coverage.

All tests use `@effect/vitest` (already the engine package's test framework) and compose mock layers for each Effect service.

---

## Phase 1: Shared Test Utilities

Create `packages/engine/src/test-utils/` containing reusable mock layers used by all three consumer packages.

### Mocks

| Mock | What it replaces | Behavior |
|---|---|---|
| `MockFileSystem` | `FileSystem.FileSystem` | In-memory file store (extends existing pattern from `RepoStore.test.ts`) |
| `MockCommandExecutor` | `CommandExecutor.CommandExecutor` | Stub that returns canned `exitCode` / `stdout` / `lines` per command string (exists in `GitClient.test.ts`) |
| `MockGitClient` | `GitClient` | In-memory "git" — clone creates dirs, rev-parse returns configurable hashes, fetch/diff are no-ops |
| `MockRepoStore` | `RepoStore` | In-memory config with `Map<string, RepoConfig>`, load/save against `MockFileSystem` |
| `MockIndexer` | `Indexer` | Stores files in a `Map`, returns canned search/glob/grep/list results, tracks indexes per repo |
| `MockCloudSync` | `CloudSync` | In-memory cloud config with configurable configured/not state |
| `MockRepobaseEngine` | `RepobaseEngine` | Combines above mocks to avoid real orchestration (or reuse the real `make` with mock sub-services) |
| `TestLogger` | `Logger.defaultLogger` | Silent / capturing logger so test output stays clean |
| `TestConsole` | `Console` | Captures `Console.log` / `Console.error` output for assertion |

### Helper

`createMockEngineLayer()` — composes all mock services into a single `Layer` usable by CLI, TUI, and MCP tests.

---

## Phase 2: CLI Tests (`packages/cli/test/`)

Use `@effect/vitest` and `@effect/cli`'s `Command.execute()` API (or run `Command.run()` against `process.argv` stubs). Compose `MockEngineLayer + TestConsole + CLI Layer` and use `Effect.provide()`. Console output asserted via captured `TestConsole`. Errors asserted via `Effect.exit` / `Cause` inspection.

| Test file | Commands / Scenarios |
|---|---|
| `add.test.ts` | Add with tracking mode (default `main`); add with pinned mode; add URL that already exists (`RepoAlreadyExistsError`); invalid GitHub URL format; error during clone (`GitError`) |
| `list.test.ts` | Empty list (no repos); list with 1+ repos showing formatted output; verify cloud status labels |
| `sync.test.ts` | Sync single repo (already up-to-date); sync single repo (updated); sync all; sync pinned repo (skipped); sync non-existent repo (`RepoNotFoundError`) |
| `remove.test.ts` | Remove existing repo; remove non-existent repo |
| `search.test.ts` | Keyword search; semantic search; hybrid search; empty results; limit option; `--repo` filter; combined flags |
| `ls.test.ts` | List all repos as directories; list files within a repo path; empty directory |
| `glob.test.ts` | Valid glob pattern matching files; no matches; invalid pattern (`InvalidPatternError`); `--repo` and `--limit` flags |
| `read.test.ts` | Read full file; read with offset/limit; read with `--no-line-numbers`; file not found (`FileNotFoundError`) |
| `grep.test.ts` | Basic regex match; case-insensitive (`-i`); context lines (`-B`, `-A`, `-C`); `--files-with-matches`; `--count`; `--type` filter; `--limit`; no matches |
| `cloud.test.ts` | Login/configure; logout/clear; status (configured/not); enable repo; disable repo; push single repo; push all; pull; not configured errors (`CloudNotConfiguredError`) |
| `helpers.test.ts` | `formatDate`, `formatRepo`, `formatFileInfo`, `formatSize`, `formatGrepResult` — pure function unit tests |

---

## Phase 3: TUI Tests (`packages/tui/test/`)

Test `App.tsx` as a state machine and each component independently by injecting mock callback handlers (no `@opentui/react` rendering — test the logic).

| Test file | What's tested |
|---|---|
| `App.test.tsx` | **Mode transitions:** initial `"list"` mode; pressing `a` → `"add"`; pressing `/` → `"search"`; pressing `d` → `"confirmDelete"`; pressing `esc` returns to `"list"` from submodes; pressing `q` in `"list"` calls `onQuit`. **Navigation:** up/down/j/k move `selectedIndex`; wrapped bounds (min 0, max len-1). **Add flow:** calls `onAddRepo` with URL → sets mode `"adding"` → shows progress → refreshes repos → returns to `"list"` on success; on error shows error state then returns. **Remove flow:** confirms then calls `onRemoveRepo` → refreshes → returns to `"list"`; cancel returns without removing. **Sync flow:** `s` calls `onSyncRepo` (single) with loading state; `S` (shift) calls `onSyncAll`; error handling. **Search flow:** calls `onSearch` → sets `"results"` mode; empty query returns to `"list"`; error handling; close results. **MCP config copy:** calls `handleCopyMcpConfig` (mock `Bun.spawn`). **Edge cases:** empty repo list disables nav/delete/sync; `cloudConfigured` prop. |
| `RepoList.test.tsx` | Empty list renders "no repos" message; populated list renders correct items; selected index highlights correct row; cloud-enabled repos show indicator; repo mode (tracking/pinned) display |
| `StatusBar.test.tsx` | Displays current mode correctly; shows message when provided; cloud status integration; MCP server status |
| `Header.test.tsx` | Version string rendering |
| `AddRepoModal.test.tsx` | Input handling; submit calls `onSubmit` with value; cancel calls `onCancel`; empty input validation |
| `SearchModal.test.tsx` | Input handling; mode selector (keyword/semantic/hybrid); submit with query + mode; cancel |
| `SearchResults.test.tsx` | Renders results list; navigation (up/down); close button; empty results; score/snippet display |
| `ProgressModal.test.tsx` | Stage rendering (cloning/indexing/complete/error); progress bar percentage; file count display; error message display |
| `ConfirmDialog.test.tsx` | Confirm calls `onConfirm`; cancel calls `onCancel`; message display |
| `config.test.ts` | Feature flags shape and defaults |
| `file-logger.test.ts` | Mock `BunFileSystem` + verify log file creation / `Logger.replaceScoped` / min log level filtering |

---

## Phase 4: MCP Server Tests (`packages/mcp-server/test/`)

Test each registered tool by calling its handler with mocked engine layers (via `ManagedRuntime.make(TestLayer)`), asserting the response content and error cases.

| Test file | Tools / Scenarios |
|---|---|
| `list_repos.test.ts` | Empty list; populated list; verify JSON response shape |
| `search.test.ts` | Keyword/semantic/hybrid modes; empty results; limit option; repo filter; error propagation |
| `list_files.test.ts` | List repo files; list subdirectory; omit params (lists all); empty directory |
| `glob_files.test.ts` | Valid glob; no matches; invalid pattern; repo filter; limit |
| `read_file.test.ts` | Read full file; offset+limit; without line numbers; file not found |
| `grep.test.ts` | Basic match; case insensitive; context lines; files-with-matches; count; type filter; limit; no matches; invalid regex |
| `tool_registration.test.ts` | Server has all 6 tools registered with correct names and input schemas |
| `runtime.test.ts` | ManagedRuntime lifecycle (dispose); SIGINT/SIGTERM shutdown handlers |

---

## Phase 5: Reconciliation Tests

| Test file | What's tested |
|---|---|
| `layer-composition.test.ts` | In each consumer package, verify that `Layer.provide` chains compile and don't cause `MissingSelf` or circular dependency errors at runtime by composing with mock layers |
| `protocol-conformance.test.ts` | MCP server tools produce correct JSON shape matching defined Zod schemas |

---

## Test Configuration

- `vitest.config.ts` in each consumer package follows the engine's vitest config pattern (inline `@effect/vitest`, vitest alias for Bun compatibility).
- Add `test` script to each consumer's `package.json`: `"test": "vitest run"`.
- CI integration: extend `.github/workflows/ci.yml` to run `bun run --cwd packages/cli test`, `bun run --cwd packages/tui test`, `bun run --cwd packages/mcp-server test`.

---

## Estimated test counts

| Package | Files | Tests |
|---|---|---|
| Shared mocks | 8–10 | — |
| CLI | 11 | ~80–100 |
| TUI | 12 | ~90–120 |
| MCP Server | 8 | ~50–70 |
| Cross-cutting | 2 | ~10–15 |
| **Total** | **~41** | **~230–305** |
