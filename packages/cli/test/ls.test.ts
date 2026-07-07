import { describe, expect, it } from "@effect/vitest";
import { Indexer } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect } from "effect";

const { listFiles } = Effect.serviceFunctions(Indexer);

describe("ls command", () => {
  it.effect("lists all repos when no path specified", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.listFilesResponse = [
        { repo: "repo-a", path: "", filename: "repo-a", isDirectory: true },
        { repo: "repo-b", path: "", filename: "repo-b", isDirectory: true },
      ];
      const files = yield* listFiles({}).pipe(Effect.provide(createMockEngineLayer(state)));
      expect(files).toHaveLength(2);
    }),
  );

  it.effect("lists files in a repo directory", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.listFilesResponse = [
        {
          repo: "my-repo",
          path: "src/index.ts",
          filename: "index.ts",
          isDirectory: false,
          size: 512,
        },
        {
          repo: "my-repo",
          path: "src/utils.ts",
          filename: "utils.ts",
          isDirectory: false,
          size: 256,
        },
      ];
      const files = yield* listFiles({ repo: "my-repo", path: "src" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(files).toHaveLength(2);
      expect(files[0].path).toBe("src/index.ts");
    }),
  );

  it.effect("returns empty array for empty directory", () =>
    Effect.gen(function* () {
      const files = yield* listFiles({ repo: "empty-repo" });
      expect(files).toHaveLength(0);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("file info includes directory flag", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.listFilesResponse = [
        { repo: "r", path: "src", filename: "src", isDirectory: true },
        { repo: "r", path: "file.ts", filename: "file.ts", isDirectory: false, size: 100 },
      ];
      const files = yield* listFiles({ repo: "r" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(files[0].isDirectory).toBe(true);
      expect(files[1].isDirectory).toBe(false);
    }),
  );
});
