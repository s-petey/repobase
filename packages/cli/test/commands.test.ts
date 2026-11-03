import { describe, expect, it } from "vitest"
import { Console, Effect, type Layer, Option, Ref } from "effect"
import { JobStore } from "@repobase/engine"
import { execSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as path from "node:path"
import { embedFailures, makeSourceRepo, tempDir, testEnv } from "../../engine/test/fixtures/jobEnv.js"
import { CliExit, handleAdd, handleReindex, handleRemove, handleSync } from "../src/commands.js"

const REPO = "acme/widgets"
const FAILED = 1
const OK = 0

const cloneAtGitHubLikePath = (files = 3) => {
  const source = makeSourceRepo(files)
  const url = path.join(tempDir("cli"), "github.com", "acme", "widgets")
  nodeFs.mkdirSync(path.dirname(url), { recursive: true })
  execSync(`git clone -q ${JSON.stringify(source.dir)} ${JSON.stringify(url)}`)
  return { source, url }
}

const add = (url: string) => handleAdd({ url, branch: Option.none(), pin: Option.none() })

type CliServices = CliExit | Layer.Success<ReturnType<typeof testEnv>["layer"]>

const cli = <A, E>(
  script: (
    run: <E2, R>(
      command: Effect.Effect<void, E2, R>
    ) => Effect.Effect<{ readonly exitCode: number; readonly out: string; readonly err: string }, E2, R>
  ) => Effect.Effect<A, E, CliServices>
) => {
  const env = testEnv()
  return Effect.gen(function* () {
    const exit = yield* CliExit
    const out: Array<string> = []
    const err: Array<string> = []
    const captured: Console.Console = {
      ...globalThis.console,
      log: (...args) => out.push(args.join(" ")),
      error: (...args) => err.push(args.join(" "))
    }
    return yield* script((command) =>
      Effect.gen(function* () {
        yield* Ref.set(exit, OK)
        out.length = 0
        err.length = 0
        yield* command.pipe(Effect.provideService(Console.Console, captured))
        return { exitCode: yield* Ref.get(exit), out: out.join("\n"), err: err.join("\n") }
      })
    )
  }).pipe(Effect.provide(CliExit.layer), Effect.provide(env.layer), Effect.runPromise)
}

describe("CLI commands", () => {
  it("adds a repo, then refuses to add it again", () => {
    const { url } = cloneAtGitHubLikePath()
    return cli((run) =>
      Effect.gen(function* () {
        const added = yield* run(add(url))
        expect(added.exitCode).toBe(OK)
        expect(added.out).toContain(`✓ Added repository: ${REPO}`)

        const again = yield* run(add(url))
        expect(again.exitCode).toBe(FAILED)
        expect(again.err).toContain(`${REPO} is already added`)
      })
    )
  })

  it.each([
    "/tmp/not-a-repo",
    "https://github.com/acme/..",
    "https://github.com/acme/.",
    "https://github.com/../widgets",
    "https://github.com/./widgets"
  ])(
    "fails on %s: not a GitHub repository, or not a folder inside the repos root",
    (url) =>
      cli((run) =>
        Effect.gen(function* () {
          const result = yield* run(add(url))
          expect(result.exitCode).toBe(FAILED)
          expect(result.err).toContain("isn't a GitHub repository URL")
        })
      )
  )

  it("fails to sync, re-index or remove a repo that isn't added", () =>
    cli((run) =>
      Effect.gen(function* () {
        for (const command of [handleSync(Option.some(REPO)), handleReindex(Option.some(REPO))]) {
          const result = yield* run(command)
          expect(result.exitCode).toBe(FAILED)
          expect(result.err).toContain(`${REPO} isn't one of your repositories`)
        }
        expect((yield* run(handleRemove(REPO))).exitCode).toBe(FAILED)
      })
    ))

  it("refuses every job command while another process runs a task", () =>
    cli((run) =>
      Effect.gen(function* () {
        yield* JobStore.use((store) => store.claimRepo("acme/gadgets", { pid: process.ppid, name: "tui" }))
        const commands = [add("https://github.com/acme/widgets"), handleSync(Option.none()), handleReindex(Option.none()), handleRemove(REPO)]
        for (const command of commands) {
          const result = yield* run(command)
          expect(result.exitCode).toBe(FAILED)
          expect(result.err).toContain(`repobase tui (pid ${process.ppid}) is running a task`)
        }
      })
    ))

  it("syncs an up-to-date repo successfully, and fails when the sync fails", () => {
    const MARKER = "CLI_SYNC_FAILS"
    const { url } = cloneAtGitHubLikePath()
    return cli((run) =>
      Effect.gen(function* () {
        yield* run(add(url))
        const upToDate = yield* run(handleSync(Option.some(REPO)))
        expect(upToDate.exitCode).toBe(OK)
        expect(upToDate.out).toContain(`${REPO}: already up to date`)

        nodeFs.writeFileSync(path.join(url, "bang.ts"), `${MARKER}\n`)
        execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm bang", { cwd: url })
        embedFailures.markers.add(MARKER)
        const failed = yield* run(handleSync(Option.some(REPO)))
        expect(failed.exitCode).toBe(FAILED)
        expect(failed.err).toContain(`✗ sync ${REPO} failed`)
      }).pipe(Effect.ensuring(Effect.sync(() => embedFailures.markers.delete(MARKER))))
    )
  })

  it("removes a repo, after which syncing it fails", () => {
    const { url } = cloneAtGitHubLikePath()
    return cli((run) =>
      Effect.gen(function* () {
        yield* run(add(url))

        const removed = yield* run(handleRemove(REPO))
        expect(removed.exitCode).toBe(OK)
        expect(removed.out).toContain(`✓ Removed repository: ${REPO}`)
        expect((yield* run(handleSync(Option.some(REPO)))).exitCode).toBe(FAILED)
      })
    )
  })
})
