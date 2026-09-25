import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GitError } from "../errors.js"

/**
 * Resolve the commit checked out in a local clone
 */
export class GitResolveHead extends Rpc.make("GitResolveHead", {
  payload: { localPath: Schema.String },
  success: Schema.Struct({ commit: Schema.String }),
  error: GitError
}) {}

/**
 * Every operation a worker thread can run for the main thread
 */
export class StepRpcs extends RpcGroup.make(GitResolveHead) {}
