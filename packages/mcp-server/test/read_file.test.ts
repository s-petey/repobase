import { describe, expect, it } from "@effect/vitest";
import { Indexer } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect } from "effect";

const { readFile } = Effect.serviceFunctions(Indexer);

describe("MCP read_file tool", () => {
  it.effect("returns file content from state", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.files.set("my-repo", [{ path: "src/main.ts", content: "line1\nline2\nline3" }]);
      const content = yield* readFile("my-repo", "src/main.ts").pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(content.repo).toBe("my-repo");
      expect(content.path).toBe("src/main.ts");
      expect(content.content).toBe("line1\nline2\nline3");
      expect(content.totalLines).toBe(3);
    }),
  );

  it.effect("handler response format is correct", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.files.set("my-repo", [{ path: "main.ts", content: "a\nb\nc" }]);
      const content = yield* readFile("my-repo", "main.ts").pipe(
        Effect.provide(createMockEngineLayer(state)),
      );

      const mapped = {
        repo: content.repo,
        path: content.path,
        content: content.content,
        totalLines: content.totalLines,
        startLine: content.startLine,
        endLine: content.endLine,
      };

      expect(mapped.repo).toBe("my-repo");
      expect(mapped.path).toBe("main.ts");
      expect(mapped.content).toBe("a\nb\nc");
      expect(mapped.totalLines).toBe(3);
      expect(mapped.startLine).toBe(1);
      expect(mapped.endLine).toBe(3);
    }),
  );

  it.effect("fails with FileNotFoundError for missing file", () =>
    Effect.gen(function* () {
      const result = yield* readFile("my-repo", "nonexistent.ts").pipe(
        Effect.provide(createMockEngineLayer()),
        Effect.flip,
      );
      expect(result._tag).toBe("FileNotFoundError");
    }),
  );

  it.effect("supports offset and limit options", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.files.set("r", [{ path: "long.ts", content: "a\nb\nc\nd\ne\n" }]);
      const content = yield* readFile("r", "long.ts", { offset: 2, limit: 2 }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(content.content).toBe("a\nb\nc\nd\ne\n");
    }),
  );
});
