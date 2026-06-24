// Typed errors for the Effect-native dispatcher vertical.
import { Data } from "effect";

export class RepoError extends Data.TaggedError("RepoError")<{ op: string; cause: unknown }> {}
export class GitError extends Data.TaggedError("GitError")<{
  args: readonly string[];
  cause: unknown;
}> {}
export class SpawnError extends Data.TaggedError("SpawnError")<{ cause: unknown }> {}
export class NotFound extends Data.TaggedError("NotFound")<{ what: string; id: string }> {}
export class Invalid extends Data.TaggedError("Invalid")<{ reason: string }> {}
export class ParseError extends Data.TaggedError("ParseError")<{
  what: string;
  cause: unknown;
  sample: string;
}> {}
