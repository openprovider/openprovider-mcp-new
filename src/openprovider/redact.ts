/**
 * PII / credential redaction for Openprovider contact + customer responses.
 *
 * Openprovider's /customers (and /contacts) endpoint conflates customer-contact
 * records with reseller sub-account user records. The latter include API
 * `secret_key`, `username`, `auth_type`, password-state timestamps, and
 * IP-allowlists. Forwarding those raw into an LLM context would leak working
 * API credentials.
 *
 * The fix is allowlist-based: keep only the fields legitimately needed for the
 * contact / registrant use case; drop everything else. Applied at the tool
 * boundary so the raw `OpenproviderClient` still returns OP's response intact
 * for internal callers that may have legitimate need for the extra fields.
 */

/** Top-level fields safe to expose for a contact / customer record. */
const SAFE_CONTACT_FIELDS = new Set([
  'id',
  'handle',
  'name',
  'company_name',
  'email',
  'phone',
  'fax',
  'address',
  'role',
  'locale',
  'reseller_id',
  'comments',
  'tags',
  'vat',
  'gender',
  'additional_data',
  'extension_additional_data',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Redact a single contact / customer record. */
function redactOne(c: unknown): unknown {
  if (!isPlainObject(c)) return c;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(c)) {
    if (SAFE_CONTACT_FIELDS.has(k)) out[k] = c[k];
  }
  return out;
}

/**
 * Redact PII/credentials from an Openprovider contact-shaped response.
 *
 * Handles three common shapes:
 *   - A list envelope: `{ results: Contact[], total }` → maps each result.
 *   - A bare array of contacts.
 *   - A single contact object.
 *
 * Anything else is returned unchanged (so non-contact payloads pass through if
 * the caller mis-wires this).
 */
export function redactContactPii(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map(redactOne);
  }
  if (isPlainObject(payload)) {
    if (Array.isArray(payload.results)) {
      return { ...payload, results: payload.results.map(redactOne) };
    }
    // single contact heuristic: must have either `id` or `handle`
    if ('id' in payload || 'handle' in payload) {
      return redactOne(payload);
    }
  }
  return payload;
}
