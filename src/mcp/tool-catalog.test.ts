import { describe, expect, it } from 'vitest';
import { buildToolCatalog } from './tool-catalog.js';

describe('buildToolCatalog', () => {
  it('lists every dispatchable tool with a description and input schema', () => {
    const cat = buildToolCatalog();
    const names = cat.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'check_domain',
        'list_domains',
        'get_domain',
        'list_contacts',
        'get_contact',
        'register_domain',
        'update_domain',
        'create_contact',
        'update_contact',
        'delete_contact',
        'list_pending_confirmations',
        'confirm_pending',
        'suggest_domain',
        'get_domain_authcode',
      ].sort(),
    );
    for (const t of cat) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
    }
  });

  it('returns 14 tools', () => {
    const cat = buildToolCatalog();
    expect(cat).toHaveLength(14);
  });

  it('catalog handler throws (never invoked — fast-path intercepts tools/call)', async () => {
    const cat = buildToolCatalog();
    const first = cat[0];
    expect(first).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await expect(first!.handler({})).rejects.toThrow('catalog entry is list-only');
  });
});
