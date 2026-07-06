import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import { PlatformError, SystemError } from "@effect/platform/Error";
import { Size } from "@effect/platform/FileSystem";

export interface MockFsState {
  files: Map<string, string>;
  directories: Set<string>;
}

export const makeDefaultFsState = (): MockFsState => ({
  files: new Map(),
  directories: new Set(),
});

const notFound = (path: string): PlatformError =>
  new SystemError({
    reason: "NotFound",
    module: "FileSystem",
    cause: `File not found ${path}`,
    method: "exitCode",
  });

export const mockFileSystem = (state: MockFsState = makeDefaultFsState()): FileSystem.FileSystem =>
  FileSystem.FileSystem.of({
    access: () => Effect.void,
    copy: () => Effect.void,
    copyFile: () => Effect.void,
    chmod: () => Effect.void,
    chown: () => Effect.void,
    exists: (path) => Effect.succeed(state.files.has(path) || state.directories.has(path)),
    link: () => Effect.void,
    makeDirectory: (path, _options) =>
      Effect.sync(() => {
        state.directories.add(path);
      }),
    makeTempDirectory: () => Effect.succeed("/tmp/mock-test"),
    makeTempDirectoryScoped: () => Effect.succeed("/tmp/mock-test"),
    makeTempFile: () => Effect.succeed("/tmp/mock-test-file"),
    makeTempFileScoped: () => Effect.succeed("/tmp/mock-test-file"),
    open: () => Effect.die("open not implemented"),
    readDirectory: () => Effect.succeed([]),
    readFile: (path) => {
      const content = state.files.get(path);
      if (content !== undefined) {
        return Effect.succeed(new TextEncoder().encode(content));
      }
      return Effect.fail(notFound(path));
    },
    readFileString: (path) => {
      const content = state.files.get(path);
      if (content !== undefined) {
        return Effect.succeed(content);
      }
      return Effect.fail(notFound(path));
    },
    readLink: () => Effect.succeed(""),
    realPath: (path) => Effect.succeed(path),
    remove: (path) =>
      Effect.sync(() => {
        state.files.delete(path);
        state.directories.delete(path);
      }),
    rename: () => Effect.void,
    sink: () => Effect.die("sink not implemented"),
    stat: (path) => {
      const content = state.files.get(path);
      if (content !== undefined) {
        return Effect.succeed({
          type: "File" as const,
          mtime: Option.some(new Date()),
          atime: Option.some(new Date()),
          ctime: Option.some(new Date()),
          birthtime: Option.some(new Date()),
          size: Size(content.length),
          dev: 0,
          ino: Option.some(0),
          mode: 0o644,
          nlink: Option.some(1),
          uid: Option.some(0),
          gid: Option.some(0),
          rdev: Option.some(0),
          blksize: Option.some(Size(4096)),
          blocks: Option.some(1),
        });
      }
      if (state.directories.has(path)) {
        return Effect.succeed({
          type: "Directory" as const,
          mtime: Option.some(new Date()),
          atime: Option.some(new Date()),
          ctime: Option.some(new Date()),
          birthtime: Option.some(new Date()),
          size: Size(0),
          dev: 0,
          ino: Option.some(0),
          mode: 0o755,
          nlink: Option.some(2),
          uid: Option.some(0),
          gid: Option.some(0),
          rdev: Option.some(0),
          blksize: Option.some(Size(4096)),
          blocks: Option.some(0),
        });
      }
      return Effect.fail(notFound(path));
    },
    stream: () => Effect.die("stream not implemented"),
    symlink: () => Effect.void,
    truncate: () => Effect.void,
    utimes: () => Effect.void,
    watch: () => Effect.die("watch not implemented"),
    writeFile: () => Effect.void,
    writeFileString: (path, content) =>
      Effect.sync(() => {
        state.files.set(path, content);
      }),
  });
