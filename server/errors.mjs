export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function publicError(error) {
  if (error instanceof AppError) return { status: error.status, code: error.code, message: error.message };
  return { status: 500, code: 'INTERNAL_ERROR', message: 'The request could not be completed. Please try again.' };
}
