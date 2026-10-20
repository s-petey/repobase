// Shared setup for end-to-end job tests: the real step definitions and worker
// handlers (in-process through RpcTest instead of a thread), with git, LanceDB
// and the job store in temp directories. Only the embedding model is faked.
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option, Ref } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { execSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeJobDefinitions } from "../../src/jobs/definitions.js"
import type { Job } from "../../src/jobs/Job.js"
import { layer as JobProgressLayer } from "../../src/jobs/JobProgress.js"
import { JobRunner, layer as JobRunnerLayer } from "../../src/jobs/JobRunner.js"
import { layerWith as JobStoreLayerWith } from "../../src/jobs/JobStore.js"
import type { RepoStoreData } from "../../src/schemas.js"
import { layer as GitClientLayer } from "../../src/services/GitClient.js"
import { Indexer, layerWith as IndexerLayerWith } from "../../src/services/Indexer.js"
import { RepoStore } from "../../src/services/RepoStore.js"
import { IndexingClient, WorkerClient } from "../../src/worker/client.js"
import { StepRpcs } from "../../src/worker/rpcs.js"
import { HandlersLayer } from "../../src/worker/server.js"

export const tempDir = (prefix: string) => nodeFs.mkdtempSync(path.join(os.tmpdir(), `repobase-${prefix}-`))

const gitCommit = (dir: string, message: string, committedAt?: string) =>
  execSync(`git add -A && git -c user.email=t@t -c user.name=t commit -qm ${JSON.stringify(message)}`, {
    cwd: dir,
    env: committedAt ? { ...process.env, GIT_COMMITTER_DATE: committedAt } : undefined
  })

/**
 * A git repo whose default branch is `branch`, with `files` small TypeScript
 * files (enough for two index batches by default), plus helpers to change it
 */
export const makeSourceRepo = (files = 60, branch = "main") => {
  const dir = tempDir("source")
  for (let i = 0; i < files; i++) {
    nodeFs.writeFileSync(path.join(dir, `file-${String(i).padStart(2, "0")}.ts`), `export const value${i} = ${i}\n`)
  }
  execSync(`git init -q -b ${branch}`, { cwd: dir })
  gitCommit(dir, "init")
  const head = () => execSync("git rev-parse HEAD", { cwd: dir }).toString().trim()
  const commitTime = () => Number(execSync("git show -s --format=%ct HEAD", { cwd: dir }).toString()) * 1000
  return {
    dir,
    head,
    commitTime,
    write: (file: string, contents: string) => nodeFs.writeFileSync(path.join(dir, file), contents),
    remove: (file: string) => nodeFs.rmSync(path.join(dir, file)),
    rename: (from: string, to: string) => execSync(`git mv ${from} ${to}`, { cwd: dir }),
    commit: (message = "change", committedAt?: string) => gitCommit(dir, message, committedAt),
    tag: (name: string) => execSync(`git tag ${name}`, { cwd: dir }),
    branch: (name: string) => execSync(`git branch ${name}`, { cwd: dir })
  }
}

export const embedFailures = { explode: false, markers: new Set<string>() }

export const embedConcurrency = { current: 0, peak: 0 }

const fakeEmbed = async (text: string) => {
  embedConcurrency.current++
  embedConcurrency.peak = Math.max(embedConcurrency.peak, embedConcurrency.current)
  try {
    // Yield, so embeds from batches that run at the same time overlap
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (embedFailures.explode && text.includes("EXPLODE")) throw new Error("model crashed")
    for (const marker of embedFailures.markers) if (text.includes(marker)) throw new Error("model crashed")
    const seed = crypto.createHash("sha256").update(text).digest()
    return Array.from({ length: 384 }, (_, i) => seed[i % seed.length] / 255 + 0.01)
  } finally {
    embedConcurrency.current--
  }
}

// config.json in memory, so tests never touch ~/.repobase
export const MemoryRepoStore = Layer.effect(
  RepoStore,
  Effect.gen(function* () {
    const data = yield* Ref.make<RepoStoreData>({ version: 1, repos: [] })
    const load = () => Ref.get(data)
    return RepoStore.of({
      load,
      save: (next) => Ref.set(data, next),
      getRepo: (id) => load().pipe(Effect.map((d) => Option.fromNullishOr(d.repos.find((r) => r.id === id)))),
      addRepo: (repo) => Ref.update(data, (d) => ({ ...d, repos: [...d.repos, repo] })),
      updateRepo: (id, update) =>
        Ref.update(data, (d) => ({ ...d, repos: d.repos.map((r) => (r.id === id ? { ...r, ...update } : r)) })),
      removeRepo: (id) => Ref.update(data, (d) => ({ ...d, repos: d.repos.filter((r) => r.id !== id) })),
      modify: (f) => Ref.update(data, f)
    })
  })
)

// A client that throws for RPCs meant for the other pool, so every job test
// checks that embedding runs only on the indexing workers
const onlyRpcs = (pool: string, allowed: (rpc: string) => boolean) =>
  Effect.map(RpcTest.makeClient(StepRpcs), (client) =>
    new Proxy(client, {
      get: (target, key, receiver) =>
        typeof key === "string" && key in target && !allowed(key)
          ? () => {
              throw new Error(`${key} ran on the ${pool} pool`)
            }
          : Reflect.get(target, key, receiver)
    })
  )

export const testEnv = (options: { readonly indexingConcurrency?: number } = {}) => {
  const reposDir = tempDir("repos")
  const indexDir = tempDir("index")
  const WorkerSide = Layer.mergeAll(GitClientLayer, IndexerLayerWith({ indexDir, embed: fakeEmbed }))
  const Workers = Layer.mergeAll(
    Layer.effect(WorkerClient)(onlyRpcs("job", (rpc) => rpc !== "IndexBatch")),
    Layer.effect(IndexingClient)(onlyRpcs("indexing", (rpc) => rpc === "IndexBatch"))
  ).pipe(Layer.provide(HandlersLayer), Layer.provideMerge(WorkerSide))
  const layer = JobRunnerLayer(
    makeJobDefinitions({ reposDir, indexingConcurrency: options.indexingConcurrency ?? 1_000 }),
    { concurrency: 2 }
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(Workers, MemoryRepoStore, JobProgressLayer)),
    Layer.provideMerge(JobStoreLayerWith({ dir: tempDir("jobs") })),
    Layer.provide(BunServices.layer)
  )
  return { reposDir, indexDir, layer }
}

const runToEnd = (input: Parameters<JobRunner["Service"]["start"]>[0]) =>
  JobRunner.use((runner) => runner.start(input).pipe(Effect.flatMap((job) => runner.await(job.id))))

// Like the TUI: no mode, so the repo tracks its default branch
export const addRepo = (url: string, repoId = "acme-widgets") =>
  runToEnd({ kind: "addRepo", repoId, payload: { url } })

export const syncRepo = (repoId = "acme-widgets", options: { readonly force?: boolean } = {}) =>
  runToEnd({ kind: "syncRepo", repoId, payload: options })

export const reindexRepo = (repoId = "acme-widgets") => runToEnd({ kind: "reindexRepo", repoId, payload: {} })

export const stepOf = (job: Job, key: string) => job.steps.find((s) => s.key === key)!

export const statuses = (job: Job) => Object.fromEntries(job.steps.map((s) => [s.key, s.status]))

export const indexedPaths = (repo: string) =>
  Indexer.use((indexer) => indexer.globFiles("**", { repo, limit: 10_000 })).pipe(
    Effect.map((files) => files.map((f) => f.path).sort())
  )
