export type ErrorCode =
  | "invalid_input"
  | "invalid_ref"
  | "invalid_task"
  | "not_found"
  | "ambiguous_id"
  | "ref_conflict"
  | "artifact_exists"
  | "lock_timeout"
  | "id_exhausted"
  | "internal";

export class ShuError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function hasErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code;
}
