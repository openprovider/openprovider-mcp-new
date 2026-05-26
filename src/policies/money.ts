export function eurToCents(eur: number): number {
  return Math.round(eur * 100);
}

export function centsToEur(cents: number): number {
  return Math.round(cents) / 100;
}

export function parseEurString(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  return Math.round(parseFloat(value) * 100);
}
