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
        'reset_domain_authcode',
        'approve_domain_transfer',
        'send_foa1_domain_transfer',
        'delete_domain',
        'restart_domain_operation',
        'renew_domain',
        'transfer_domain',
        'trade_domain',
        'restore_domain',
        'list_dns_zones',
        'get_dns_zone',
        'list_dns_zone_records',
        'list_nameservers',
        'get_nameserver',
        'list_ns_groups',
        'get_ns_group',
        'list_dns_templates',
        'get_dns_template',
        'create_dns_zone',
        'update_dns_zone',
        'create_nameserver',
        'update_nameserver',
        'create_ns_group',
        'update_ns_group',
        'create_dns_template',
        'create_domain_token',
        'delete_dns_zone',
        'delete_nameserver',
        'delete_ns_group',
        'delete_dns_template',
        'list_tlds',
        'get_tld',
        'get_domain_price',
        'list_tags',
        'create_tag',
        'delete_tag',
        'list_ssl_products',
        'get_ssl_product',
        'list_ssl_orders',
        'get_ssl_order',
        'get_ssl_approver_emails',
        'update_ssl_order',
        'update_ssl_approver_email',
        'resend_ssl_approver_email',
        'create_csr',
        'decode_csr',
        'create_ssl_otp_token',
        'create_ssl_order',
        'renew_ssl_order',
        'reissue_ssl_order',
        'cancel_ssl_order',
        'list_customers',
        'get_customer',
        'create_customer',
        'update_customer',
        'delete_customer',
        'list_email_templates',
        'create_email_template',
        'update_email_template',
        'delete_email_template',
        'list_email_verification_domains',
        'start_email_verification',
        'restart_email_verification',
        'get_dmarc',
        'list_dmarc_subscriptions',
        'create_dmarc',
        'retry_dmarc',
        'dmarc_sso_login',
        'delete_dmarc',
        'get_spam_experts_domain',
        'spam_experts_login_url',
        'create_spam_experts_domain',
        'update_spam_experts_domain',
        'delete_spam_experts_domain',
        'list_license_prices',
        'list_license_items',
        'list_plesk_licenses',
        'get_plesk_license',
        'get_plesk_key',
        'create_plesk_license',
        'update_plesk_license',
        'reset_plesk_hwid',
        'delete_plesk_license',
      ].sort(),
    );
    for (const t of cat) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
    }
  });

  it('returns 88 tools', () => {
    const cat = buildToolCatalog();
    expect(cat).toHaveLength(97);
  });

  it('catalog handler throws (never invoked — fast-path intercepts tools/call)', async () => {
    const cat = buildToolCatalog();
    const first = cat[0];
    expect(first).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await expect(first!.handler({})).rejects.toThrow('catalog entry is list-only');
  });
});
