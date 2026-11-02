export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export function errorPayload(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  return { statusCode: 500, code: "INTERNAL_ERROR", message: "An unexpected error occurred" };
}
