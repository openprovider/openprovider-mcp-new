export const REDACTED = '[REDACTED]';

// Single source of truth per spec §8. Order: alphabetical for snapshot stability.
export const REDACTED_PATHS = new Set<string>([
  'api_key',
  'authorization',
  'ciphertext',
  'client_secret',
  'contact.inn',
  'contact.password',
  'contact.social_security_number',
  'cookie',
  'data.token',
  'password',
  'plaintext',
  'refresh_token',
  'wrapped_dek',
]);

export function redactSensitive(value: unknown, prefix = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, prefix));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (REDACTED_PATHS.has(path) || REDACTED_PATHS.has(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactSensitive(v, path);
      }
    }
    return out;
  }
  return value;
}
