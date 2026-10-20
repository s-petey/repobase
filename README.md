# Repobase

[![npm version](https://img.shields.io/npm/v/repobase.svg)](https://www.npmjs.com/package/repobase)
[![npm downloads](https://img.shields.io/npm/dm/repobase.svg)](https://www.npmjs.com/package/repobase)
[![CI](https://github.com/fernandoabolafio/repobase/actions/workflows/release.yml/badge.svg)](https://github.com/fernandoabolafio/repobase/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

![Repobase TUI](packages/website/src/assets/tui-screenshot.png)

Index and search your Git repositories with AI. Includes a terminal UI and MCP server for AI tool integration.

## Installation

Requires [Bun](https://bun.sh) runtime.

```bash
# Install globally
npm install -g repobase

# Or with bun
bun install -g repobase
```

## Usage

### Terminal UI

```bash
repobase
```

**Keyboard shortcuts:**

- `a` - Add repository
- `d` - Delete repository
- `s` - Sync selected repository
- `S` - Sync all repositories
- `/` - Search
- `t` - Tasks: background add and sync jobs
- `q` - Quit

### Background tasks

Adding and syncing a repository run as tasks on worker threads, so the UI stays responsive while repositories are cloned and indexed. Each task is split into steps that are saved to disk as they finish. If a step fails, or you quit mid-task, you can retry the task from the step where it stopped. For indexing, only the batches of files that failed are retried.

Syncs run in the background, with their progress in the status bar. `Esc` hides an add's progress while it keeps going. When a repository's last sync was interrupted, or failed once indexing had started, `s` and `S` resume that task instead of starting over.

Press `t` to open the Tasks view:

- The list shows every task with its status. Tasks interrupted in a previous session show up here after startup.
- The selected task shows its steps, and a failed step shows its error with a hint.
- `r` retries the task. It's unavailable when retrying can't help, for example when the tracked branch no longer exists.
- `x` discards the task. `Esc` or `q` closes the view.

Tasks use two kinds of worker threads:

- **Indexing workers** compute the embeddings for search, the CPU-heavy part: one batch of files uses about 5 cores. Each holds its own copy of the embedding model, so there are only a few: as many as fit in about half of your cores, and at least one. They start with repobase and stay for the whole session. To change how many, set `REPOBASE_MAX_INDEXING`, for example `REPOBASE_MAX_INDEXING=2 repobase` to finish a large Sync All sooner at the cost of more CPU and memory.
- **Workers** run everything else: cloning, fetching and planning. One of them is kept for search. By default there are up to 4, fewer on machines with less CPU or memory, and an idle one stops after a minute. To change the limit, set `REPOBASE_MAX_WORKERS`. With `REPOBASE_MAX_WORKERS=1`, search shares the indexing workers, so `REPOBASE_MAX_WORKERS=1 REPOBASE_MAX_INDEXING=1 repobase` is the smallest setup: two threads.

### Command line

With arguments, `repobase` runs a command instead of opening the TUI:

```bash
repobase --wizard                              # pick a command and fill in its arguments step by step
repobase add https://github.com/honojs/hono    # add and index a repository
repobase list                                  # list repositories
repobase sync [id]                             # sync one repository, or all of them
repobase reindex [id]                          # re-index one, or every one in an old index format
repobase remove <id>                           # remove a repository
repobase search <query>                        # search (add --semantic or --hybrid)
repobase grep <pattern>                        # search file contents with a regex
repobase --help                                # every command and its options
```

Commands run in the foreground, without the TUI's worker threads.

### MCP Server (Cursor, Claude, etc.)

Add to your MCP configuration (`~/.cursor/mcp.json` or Claude config):

```json
{
  "mcpServers": {
    "repobase": {
      "command": "repobase-mcp"
    }
  }
}
```

**Available tools:**

- `list_repos` - List all indexed repositories
- `search` - Search across repositories (keyword, semantic, or hybrid mode)
- `list_files` - List files in a repository
- `glob_files` - Find files by glob pattern
- `read_file` - Read file contents
- `grep` - Search file contents with regex

## Troubleshooting

repobase keeps its state and logs in `~/.repobase`:

- `tui.log` - the terminal UI's log
- `worker.log` - the worker threads' log, for errors in a task's steps
- `jobs/` - the saved tasks, with each step's status and error. Use the Tasks view (`t`) to retry or discard them.
- `config.json` - the repositories you've added
- `repos/` and `index/` - the cloned repositories and the search index

### Tracing

repobase can send traces and logs over OpenTelemetry (OTLP/HTTP) to see where time goes: searches, greps, and each task's steps and index batches. It's off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; `OTEL_SDK_DISABLED=true` turns it off again.

For the MCP server, add the variable to its config:

```json
{
  "mcpServers": {
    "repobase": {
      "command": "repobase-mcp",
      "env": { "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:27686" }
    }
  }
}
```

Each process reports as its own service: `repobase-tui`, `repobase-worker` (the worker threads), `repobase-mcp` and `repobase-cli`. A task's steps and the worker work they start share one trace.

## Development

```bash
# Install dependencies
bun install

# Run TUI in dev mode
bun run dev:tui

# Run MCP server in dev mode
bun run dev:mcp

# Run tests
bun run test

# Build for distribution
bun run build
```

### LanceDB log level

The TUI and CLI start with `LANCEDB_LOG=error`: `bun run dev:tui` sets it through the TUI's `start` script, and the published `repobase` command sets it in the shebang of `dist/bin/repobase.js`.

LanceDB's Rust core logs warnings to stderr, and anything on stderr draws over the terminal UI. Hybrid search always triggers one: a deprecation warning about `_score`/`_distance` auto-projection that comes from LanceDB's internal sub-queries. LanceDB 0.39 has no JS API to turn that off, so the only fix is the log level. Errors are still logged.

It has to be set when the process starts. LanceDB reads `LANCEDB_LOG` once, when its native addon loads, and under Bun a `process.env` change made at runtime doesn't reach native code. That's why it lives in the launch commands rather than in the Indexer.

To see LanceDB's warnings or debug output while developing, set your own level; the `start` script keeps it: `LANCEDB_LOG=debug bun run dev:tui`. The published `repobase` command always forces `error`, because a shebang can't fall back to an existing value. To use another level there, run the bundle directly: `LANCEDB_LOG=debug bun "$(npm root -g)/repobase/dist/tui/main.js"`.

### Measuring UI responsiveness

Set `REPOBASE_DEBUG_LAG=1` to sample how responsive the main (render) thread is: `REPOBASE_DEBUG_LAG=1 bun run dev:tui`. Every 5 seconds, `~/.repobase/tui.log` gets a line with the maximum and 95th-percentile event-loop lag. It's logged as a warning when any tick was more than 50ms late, which is when rendering and input start to feel sluggish.

### Forcing a full re-index on sync

Set `REPOBASE_FORCE_SYNC=1` to make every sync re-index all of a repository's files, even when it's already up to date. It's useful for exercising many tasks indexing at once, for example with `S` (Sync All): `REPOBASE_FORCE_SYNC=1 REPOBASE_DEBUG_LAG=1 bun run dev:tui`. It only changes how new syncs run, not the saved history of tasks.

### Dependency versions

Versions shared between workspace packages live in the [catalog](https://bun.com/docs/pm/catalogs) under `workspaces.catalog` in the root `package.json`; packages reference them with `"catalog:"`. To bump a shared dependency, change it in the catalog.

The root package's `dependencies` are the exception: releases publish with `npm publish`, which can't resolve `catalog:`, so they stay literal versions. When you bump one of them in the catalog, update the matching entry in the root `dependencies` too.

## Architecture

```
repobase/
├── packages/
│   ├── engine/      # Core library (indexing, search, git operations)
│   ├── tui/         # Terminal UI
│   └── mcp-server/  # MCP server for AI tools
└── dist/            # Built distribution (after bun run build)
```

## Contributing

This project uses [Conventional Commits](https://www.conventionalcommits.org/) for automated versioning and changelog generation.

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types:**

- `feat:` - New features (triggers minor version bump)
- `fix:` - Bug fixes (triggers patch version bump)
- `perf:` - Performance improvements (triggers patch version bump)
- `refactor:` - Code refactoring (triggers patch version bump)
- `docs:` - Documentation changes (no release)
- `style:` - Code style changes (no release)
- `test:` - Test changes (no release)
- `chore:` - Maintenance tasks (no release)
- `ci:` - CI/CD changes (no release)

**Breaking Changes:**

Add `BREAKING CHANGE:` in the commit footer or `!` after the type to trigger a major version bump:

```
feat!: remove deprecated API

BREAKING CHANGE: The old API has been removed.
```

### Release Process

1. **Merges to `main`** automatically publish a release candidate to npm with the `@next` tag
2. **Manual trigger** of the "Promote to Latest" workflow publishes to `@latest` and creates a GitHub release

## License

MIT
