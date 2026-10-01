import type { AppError, FileConflict } from '../../src/shared/model';
export class UserError extends Error {
  constructor(
    message: string,
    public readonly conflicts?: FileConflict[],
    public readonly details?: string,
    public readonly context?: Pick<
      AppError,
      'requirements' | 'retryable' | 'confirmation' | 'unverifiedPrerequisites'
    >,
    public readonly statusCode?: number,
  ) {
    super(message);
  }
}
export function errorReply(error: unknown): AppError {
  if (error instanceof UserError)
    return {
      message: error.message,
      conflicts: error.conflicts,
      details: error.details,
      ...error.context,
    };
  const code = (error as NodeJS.ErrnoException)?.code;
  const message =
    code === 'EACCES' || code === 'EPERM'
      ? 'Modatro cannot change this file. Close Balatro and check that you have permission to use this folder.'
      : code === 'ENOSPC'
        ? 'There is not enough free space. Free up space and try again.'
        : code === 'ENOENT'
          ? 'A required file is missing. Check your folders and try again.'
          : 'The operation could not be completed. Your files were preserved wherever recovery was possible. See technical details.';
  return { message, details: error instanceof Error ? error.stack : String(error) };
}
