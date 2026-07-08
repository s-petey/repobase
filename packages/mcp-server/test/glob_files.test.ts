import { describe, expect, it } from "@effect/vitest";
import { Indexer } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect } from "effect";

const { globFiles } = Effect.serviceFunctions(Indexer);

describe("MCP glob_files tool", () => {
  it.effect("returns matching files from state", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      const mtime = new Date("2024-06-15");
      state.indexer.globFilesResponse = [
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
          path: "src/lib.ts",
          filename: "lib.ts",
          isDirectory: false,
          size: 2048,
          mtime,
        },
      ];
      const files = yield* globFiles("*.ts", { repo: "my-repo" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(files).toHaveLength(2);
    }),
  );

  it.effect("returns default results when no state set", () =>
    Effect.gen(function* () {
      const files = yield* globFiles("*.ts");
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]).toHaveProperty("repo");
      expect(files[0]).toHaveProperty("path");
      expect(files[0]).toHaveProperty("filename");
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("handler response format includes mapped fields", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      const mtime = new Date("2024-06-15");
      state.indexer.globFilesResponse = [
        { repo: "r", path: "src/a.ts", filename: "a.ts", isDirectory: false, size: 100, mtime },
      ];
      const files = yield* globFiles("*.ts", { repo: "r" }).pipe(
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

      expect(mapped[0].repo).toBe("r");
      expect(mapped[0].size).toBe(100);
      expect(mapped[0].mtime).toBe("2024-06-15T00:00:00.000Z");
    }),
  );

  it.effect("respects limit option", () =>
    Effect.gen(function* () {
      const files = yield* globFiles("*.ts", { limit: 5 });
      expect(files.length).toBeLessThanOrEqual(5);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );
});
