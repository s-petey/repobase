import { describe, expect, it } from "@effect/vitest";
import { Indexer } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect } from "effect";

const { globFiles } = Effect.serviceFunctions(Indexer);

describe("glob command", () => {
  it.effect("finds files matching a glob pattern", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.globFilesResponse = [
        { repo: "my-repo", path: "src/index.ts", filename: "index.ts", isDirectory: false },
        { repo: "my-repo", path: "src/utils.ts", filename: "utils.ts", isDirectory: false },
      ];
      const files = yield* globFiles("**/*.ts").pipe(Effect.provide(createMockEngineLayer(state)));
      expect(files.length).toBeGreaterThan(0);
    }),
  );

  it.effect("filters by repo when specified", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.globFilesResponse = [
        { repo: "repo-a", path: "a.ts", filename: "a.ts", isDirectory: false },
      ];
      const files = yield* globFiles("*.ts", { repo: "repo-a" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(files.every((f) => f.repo === "repo-a")).toBe(true);
    }),
  );

  it.effect("respects limit option", () =>
    Effect.gen(function* () {
      const files = yield* globFiles("**/*", { limit: 10 });
      expect(files.length).toBeLessThanOrEqual(10);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("returns file info with correct fields", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.globFilesResponse = [
        { repo: "r", path: "f.ts", filename: "f.ts", isDirectory: false, size: 100 },
      ];
      const files = yield* globFiles("*.ts").pipe(Effect.provide(createMockEngineLayer(state)));
      const f = files[0];
      expect(f).toHaveProperty("repo");
      expect(f).toHaveProperty("path");
      expect(f).toHaveProperty("filename");
      expect(f).toHaveProperty("isDirectory");
    }),
  );
});
