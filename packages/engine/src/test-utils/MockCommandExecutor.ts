import { Command, CommandExecutor } from "@effect/platform";
import { ExitCode, TypeId } from "@effect/platform/CommandExecutor";
import { SystemError, type PlatformError } from "@effect/platform/Error";
import { Effect } from "effect";

export interface MockCommandEntry {
  stdout?: string;
  exitCode?: number;
  error?: string;
}

export interface MockCommandExecutorState {
  commands: Map<string, MockCommandEntry>;
}

export const makeDefaultCmdState = (): MockCommandExecutorState => ({
  commands: new Map(),
});

const unknownCommand = (cmd: string): PlatformError =>
  new SystemError({
    reason: "Unknown",
    module: "Command",
    cause: `Unknown command: ${cmd}`,
    method: "exitCode",
  });

export const mockCommandExecutor = (
  state: MockCommandExecutorState = makeDefaultCmdState(),
): CommandExecutor.CommandExecutor =>
  CommandExecutor.CommandExecutor.of({
    start: () => Effect.die("start not implemented in mock"),
    exitCode: (command) => {
      const cmd = Command.flatten(command)
        .map((c) => [c.command, ...c.args].join(" "))
        .join(" | ");
      const mock = state.commands.get(cmd);
      if (!mock) return Effect.fail(unknownCommand(cmd));
      if (mock.error) return Effect.fail(unknownCommand(cmd));
      return Effect.succeed(ExitCode(mock.exitCode ?? 0));
    },
    string: (command) => {
      const cmd = Command.flatten(command)
        .map((c) => [c.command, ...c.args].join(" "))
        .join(" | ");
      const mock = state.commands.get(cmd);
      if (!mock) return Effect.fail(unknownCommand(cmd));
      if (mock.error) return Effect.fail(unknownCommand(cmd));
      return Effect.succeed(mock.stdout ?? "");
    },
    lines: (command) => {
      const cmd = Command.flatten(command)
        .map((c) => [c.command, ...c.args].join(" "))
        .join(" | ");
      const mock = state.commands.get(cmd);
      if (!mock) return Effect.fail(unknownCommand(cmd));
      if (mock.error) return Effect.fail(unknownCommand(cmd));
      const lines = (mock.stdout ?? "").split("\n").filter((l) => l.length > 0);
      return Effect.succeed(lines);
    },
    stream: () => Effect.die("stream not implemented in mock"),
    streamLines: () => Effect.die("streamLines not implemented in mock"),
    [TypeId]: TypeId,
  });
