import { describe, expect, it } from "@effect/vitest";
import { Indexer } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect } from "effect";

const { readFile } = Effect.serviceFunctions(Indexer);

describe("read command", () => {
  it.effect("reads file content", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.files.set("my-repo", [
        { path: "src/main.ts", content: "const x = 1\nconst y = 2\n" },
      ]);
      const result = yield* readFile("my-repo", "src/main.ts").pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(result.repo).toBe("my-repo");
      expect(result.path).toBe("src/main.ts");
      expect(result.totalLines).toBeGreaterThan(0);
    }),
  );

  it.effect("fails with FileNotFoundError for missing file", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(readFile("my-repo", "nonexistent.ts"));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("handles offset option", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.files.set("r", [{ path: "f.txt", content: "line1\nline2\nline3\n" }]);
      const result = yield* readFile("r", "f.txt", { offset: 2 }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(result.startLine).toBeGreaterThanOrEqual(1);
    }),
  );

  it.effect("handles limit option", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.files.set("r", [{ path: "f.txt", content: "a\nb\nc\nd\ne\n" }]);
      const result = yield* readFile("r", "f.txt", { limit: 3 }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(result.totalLines).toBeGreaterThanOrEqual(1);
    }),
  );
});
