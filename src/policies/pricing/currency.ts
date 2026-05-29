export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class UnsupportedCurrencyError extends Error {
  readonly code = 'unsupported_currency';
  constructor(currency: string) {
    super(`Unsupported currency: ${currency}. Pricing supports EUR only.`);
    this.name = 'UnsupportedCurrencyError';
  }
}
