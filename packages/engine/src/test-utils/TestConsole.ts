import { Console, Effect, Layer } from "effect";

export interface CapturedConsole {
  readonly logs: Array<Array<unknown>>;
  readonly errors: Array<Array<unknown>>;
}

export const makeCapturedConsole = (): CapturedConsole => ({
  logs: [],
  errors: [],
});

export const testConsoleLayer = (
  captured: CapturedConsole = makeCapturedConsole(),
): Layer.Layer<Console.Console> =>
  Layer.succeed(
    Console.Console,
    Console.Console.of({
      [Console.TypeId]: Console.TypeId,
      assert: () => Effect.void,
      clear: Effect.void,
      count: () => Effect.void,
      countReset: () => Effect.void,
      debug: (...args) =>
        Effect.sync(() => {
          // @ts-ignore - Testing mocks ignoring for now
          captured.logs.push(args);
        }),
      dir: () => Effect.void,
      dirxml: () => Effect.void,
      error: (...args) =>
        Effect.sync(() => {
          // @ts-ignore - Testing mocks ignoring for now
          captured.errors.push(args);
        }),
      group: () => Effect.void,
      groupEnd: Effect.void,
      info: (...args) =>
        Effect.sync(() => {
          // @ts-ignore - Testing mocks ignoring for now
          captured.logs.push(args);
        }),
      log: (...args) =>
        Effect.sync(() => {
          // @ts-ignore - Testing mocks ignoring for now
          captured.logs.push(args);
        }),
      table: () => Effect.void,
      time: () => Effect.void,
      timeEnd: () => Effect.void,
      timeLog: () => Effect.void,
      trace: (...args) =>
        Effect.sync(() => {
          // @ts-ignore - Testing mocks ignoring for now
          captured.logs.push(args);
        }),
      warn: (...args) =>
        Effect.sync(() => {
          // @ts-ignore - Testing mocks ignoring for now
          captured.logs.push(args);
        }),
      unsafe: console,
    }),
  );
