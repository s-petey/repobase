import { Layer, Logger, LogLevel } from "effect";

export const silentLoggerLayer: Layer.Layer<never> = Logger.minimumLogLevel(LogLevel.None);

export const captureLoggerLayer = (captured: Array<string> = []): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    // @ts-ignore - Testing mocks ignoring for now
    Logger.make((_, message) => {
      captured.push(message);
    }),
  ).pipe(Layer.provideMerge(Logger.minimumLogLevel(LogLevel.All)));
