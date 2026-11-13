export class ServiceError extends Error {
  constructor(code, status = 400, retryable = false) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
