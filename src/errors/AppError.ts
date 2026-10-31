type AppErrorOptions = {
  retryAfterSeconds?: number;
};

export class AppError extends Error {
  public readonly retryAfterSeconds?: number;

  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    options: AppErrorOptions = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.retryAfterSeconds = options.retryAfterSeconds;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
