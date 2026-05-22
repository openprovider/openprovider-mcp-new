export class OpenproviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenproviderAuthError';
  }
}
export class OpenproviderRateLimitError extends Error {
  constructor(
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'OpenproviderRateLimitError';
  }
}
export class OpenproviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenproviderUnavailableError';
  }
}
export class OpenproviderClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public upstreamCode?: string,
  ) {
    super(message);
    this.name = 'OpenproviderClientError';
  }
}
