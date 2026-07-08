import { describe, expect, it } from "@effect/vitest";
import { Indexer } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect } from "effect";

const { listFiles } = Effect.serviceFunctions(Indexer);

describe("MCP list_files tool", () => {
  it.effect("returns files from state", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      const mtime = new Date("2024-06-15");
      state.indexer.listFilesResponse = [
        {
          repo: "my-repo",
          path: "src/main.ts",
          filename: "main.ts",
          isDirectory: false,
          size: 1024,
          mtime,
        },
        {
          repo: "my-repo",
          path: "src/utils.ts",
          filename: "utils.ts",
          isDirectory: false,
          size: 512,
          mtime,
        },
      ];
      const files = yield* listFiles({ repo: "my-repo" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(files).toHaveLength(2);
      expect(files[0].filename).toBe("main.ts");
      expect(files[1].filename).toBe("utils.ts");
    }),
  );

  it.effect("handler response format includes mapped fields", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      const mtime = new Date("2024-06-15");
      state.indexer.listFilesResponse = [
        { repo: "r", path: "src/a.ts", filename: "a.ts", isDirectory: false, size: 100, mtime },
        { repo: "r", path: "src/dir", filename: "dir", isDirectory: true },
      ];
      const files = yield* listFiles({ repo: "r" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );

      const mapped = files.map((f) => ({
        repo: f.repo,
        path: f.path,
        filename: f.filename,
        isDirectory: f.isDirectory,
        size: f.size ?? null,
        mtime: f.mtime?.toISOString() ?? null,
      }));

      expect(mapped).toHaveLength(2);
      expect(mapped[0].size).toBe(100);
      expect(mapped[0].mtime).toBe("2024-06-15T00:00:00.000Z");
      expect(mapped[1].isDirectory).toBe(true);
      expect(mapped[1].size).toBeNull();
      expect(mapped[1].mtime).toBeNull();
    }),
  );

  it.effect("returns empty array when no files", () =>
    Effect.gen(function* () {
      const files = yield* listFiles({});
      expect(files).toHaveLength(0);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );
});
