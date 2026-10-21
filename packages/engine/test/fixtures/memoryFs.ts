import { Effect, FileSystem, Layer, Path, PlatformError, PubSub, Stream } from "effect"

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

const notFound = (method: string, path: string) =>
  PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path })

export const makeMemoryFs = Effect.gen(function* () {
  const files = new Map<string, string>()
  const events = yield* PubSub.unbounded<FileSystem.WatchEvent>()
  const emit = (_tag: FileSystem.WatchEvent["_tag"], path: string) =>
    PubSub.publish(events, { _tag, path: nameOf(path) }).pipe(Effect.asVoid)
  const under = (dir: string) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`))

  const fileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.sync(() => files.has(path) || under(path).length > 0),
    makeDirectory: () => Effect.void,
    readDirectory: (dir) => Effect.sync(() => under(dir).map((path) => path.slice(dir.length + 1))),
    readFileString: (path) => {
      const contents = files.get(path)
      return contents === undefined ? Effect.fail(notFound("readFileString", path)) : Effect.succeed(contents)
    },
    writeFileString: (path, data) => Effect.sync(() => files.set(path, data)).pipe(Effect.andThen(emit("Create", path))),
    rename: (from, to) => {
      const contents = files.get(from)
      if (contents === undefined) return Effect.fail(notFound("rename", from))
      return Effect.sync(() => {
        files.delete(from)
        files.set(to, contents)
      }).pipe(Effect.andThen(emit("Remove", from)), Effect.andThen(emit("Create", to)))
    },
    watch: () => Stream.fromPubSub(events)
  })

  return { files, layer: Layer.merge(Layer.succeed(FileSystem.FileSystem)(fileSystem), Path.layer) }
})
