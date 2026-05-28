import { describe, expect, it } from 'vitest';
import {
  RenewDomainArgs,
  TransferDomainArgs,
  TradeDomainArgs,
  RestoreDomainArgs,
  RestartDomainOperationArgs,
  ApproveTransferArgs,
  ResetAuthcodeArgs,
  SuggestDomainArgs,
  DomainIdArg,
} from './types.js';
import {
  CreateDnsZoneArgs,
  UpdateDnsZoneArgs,
  ZoneNameArg,
  CreateNameserverArgs,
  UpdateNameserverArgs,
  NameserverNameArg,
  CreateNsGroupArgs,
  UpdateNsGroupArgs,
  NsGroupNameArg,
  CreateDnsTemplateArgs,
  TemplateIdArg,
  CreateDomainTokenArgs,
  NoArgs,
} from './types.js';
import { TldNameArg, GetDomainPriceArgs, CreateTagArgs, DeleteTagArgs } from './types.js';
import {
  SslOrderIdArg,
  SslProductIdArg,
  GetSslApproverEmailsArgs,
  CreateSslOrderArgs,
  UpdateSslOrderArgs,
  ReissueSslOrderArgs,
  RenewSslOrderArgs,
  CancelSslOrderArgs,
  UpdateSslApproverEmailArgs,
  ResendSslApproverEmailArgs,
  CreateCsrArgs,
  DecodeCsrArgs,
  CreateSslOtpTokenArgs,
} from './types.js';
import { CustomerHandleArg, CreateCustomerArgs, UpdateCustomerArgs } from './types.js';
import {
  EmailTemplateIdArg,
  EasyDmarcIdArg,
  SpamExpertsDomainArg,
  GetDmarcArgs,
  CreateEmailTemplateArgs,
  UpdateEmailTemplateArgs,
  StartEmailVerificationArgs,
  RestartEmailVerificationArgs,
  CreateDmarcArgs,
  RetryDmarcArgs,
  DmarcSsoLoginArgs,
  SpamExpertsLoginUrlArgs,
  CreateSpamExpertsDomainArgs,
  UpdateSpamExpertsDomainArgs,
} from './types.js';

describe('batch1 domain-lifecycle schemas', () => {
  it('DomainIdArg requires positive int id', () => {
    expect(DomainIdArg.safeParse({ id: 5 }).success).toBe(true);
    expect(DomainIdArg.safeParse({ id: -1 }).success).toBe(false);
    expect(DomainIdArg.safeParse({}).success).toBe(false);
  });
  it('RenewDomainArgs requires id + period', () => {
    expect(RenewDomainArgs.safeParse({ id: 1, period: 1 }).success).toBe(true);
    expect(RenewDomainArgs.safeParse({ id: 1 }).success).toBe(false);
  });
  it('TransferDomainArgs requires domain + auth_code + owner_handle', () => {
    expect(
      TransferDomainArgs.safeParse({
        domain: { name: 'x', extension: 'com' },
        auth_code: 'a',
        owner_handle: 'H',
      }).success,
    ).toBe(true);
    expect(TransferDomainArgs.safeParse({ domain: { name: 'x', extension: 'com' } }).success).toBe(
      false,
    );
  });
  it('TradeDomainArgs requires domain + auth_code + owner_handle', () => {
    expect(
      TradeDomainArgs.safeParse({
        domain: { name: 'x', extension: 'com' },
        auth_code: 'a',
        owner_handle: 'H',
      }).success,
    ).toBe(true);
    expect(TradeDomainArgs.safeParse({}).success).toBe(false);
  });
  it('RestoreDomainArgs requires id', () => {
    expect(RestoreDomainArgs.safeParse({ id: 7 }).success).toBe(true);
    expect(RestoreDomainArgs.safeParse({}).success).toBe(false);
  });
  it('RestartDomainOperationArgs requires id', () => {
    expect(RestartDomainOperationArgs.safeParse({ id: 7 }).success).toBe(true);
    expect(RestartDomainOperationArgs.safeParse({}).success).toBe(false);
  });
  it('ApproveTransferArgs requires id', () => {
    expect(ApproveTransferArgs.safeParse({ id: 7 }).success).toBe(true);
    expect(ApproveTransferArgs.safeParse({}).success).toBe(false);
  });
  it('ResetAuthcodeArgs requires id', () => {
    expect(ResetAuthcodeArgs.safeParse({ id: 7 }).success).toBe(true);
    expect(ResetAuthcodeArgs.safeParse({}).success).toBe(false);
  });
  it('SuggestDomainArgs requires name', () => {
    expect(SuggestDomainArgs.safeParse({ name: 'example' }).success).toBe(true);
    expect(SuggestDomainArgs.safeParse({}).success).toBe(false);
  });
});

describe('batch2 DNS schemas', () => {
  it('NoArgs accepts empty object', () => {
    expect(NoArgs.safeParse({}).success).toBe(true);
  });
  it('CreateDnsZoneArgs requires domain+provider+type, records flat array', () => {
    expect(
      CreateDnsZoneArgs.safeParse({
        domain: { name: 'x', extension: 'com' },
        provider: 'openprovider',
        type: 'master',
        records: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }],
      }).success,
    ).toBe(true);
    expect(CreateDnsZoneArgs.safeParse({ domain: { name: 'x', extension: 'com' } }).success).toBe(
      false,
    ); // missing provider+type
    expect(
      CreateDnsZoneArgs.safeParse({
        domain: { name: 'x', extension: 'com' },
        provider: 'openprovider',
        type: 'invalid',
      }).success,
    ).toBe(false);
  });
  it('UpdateDnsZoneArgs uses records.add/remove OBJECT, not flat array', () => {
    expect(
      UpdateDnsZoneArgs.safeParse({
        domain: { name: 'x', extension: 'com' },
        records: { add: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }] },
      }).success,
    ).toBe(true);
    expect(
      UpdateDnsZoneArgs.safeParse({
        domain: { name: 'x', extension: 'com' },
        records: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }],
      }).success,
    ).toBe(false); // flat array invalid on update
    expect(UpdateDnsZoneArgs.safeParse({ domain: { name: 'x', extension: 'com' } }).success).toBe(
      true,
    ); // partial update allowed
  });
  it('ZoneNameArg / NameserverNameArg / NsGroupNameArg require their identifier', () => {
    expect(ZoneNameArg.safeParse({ name: 'example.com' }).success).toBe(true);
    expect(ZoneNameArg.safeParse({}).success).toBe(false);
    expect(NameserverNameArg.safeParse({ name: 'ns1.x.com' }).success).toBe(true);
    expect(NsGroupNameArg.safeParse({ ns_group: 'G' }).success).toBe(true);
    expect(NsGroupNameArg.safeParse({}).success).toBe(false);
  });
  it('CreateNameserverArgs requires name+ip; ip6 optional', () => {
    expect(CreateNameserverArgs.safeParse({ name: 'ns1.x.com', ip: '1.2.3.4' }).success).toBe(true);
    expect(CreateNameserverArgs.safeParse({ name: 'ns1.x.com' }).success).toBe(false);
    expect(
      UpdateNameserverArgs.safeParse({ name: 'ns1.x.com', ip: '1.2.3.4', ip6: '::1' }).success,
    ).toBe(true);
  });
  it('CreateNsGroupArgs requires ns_group + at-least-one name_servers member', () => {
    expect(
      CreateNsGroupArgs.safeParse({
        ns_group: 'G',
        name_servers: [{ name: 'ns1.x.com', ip: '1.2.3.4', seq_nr: 0 }],
      }).success,
    ).toBe(true);
    expect(CreateNsGroupArgs.safeParse({ ns_group: 'G', name_servers: [] }).success).toBe(false);
    expect(
      UpdateNsGroupArgs.safeParse({
        ns_group: 'G',
        name_servers: [{ name: 'ns1.x.com', ip: '1.2.3.4', seq_nr: 0 }],
      }).success,
    ).toBe(true);
  });
  it('CreateDnsTemplateArgs requires name; records optional', () => {
    expect(CreateDnsTemplateArgs.safeParse({ name: 'T' }).success).toBe(true);
    expect(
      CreateDnsTemplateArgs.safeParse({
        name: 'T',
        records: [{ type: 'A', value: '%domain%', ttl: 3600 }],
      }).success,
    ).toBe(true);
    expect(CreateDnsTemplateArgs.safeParse({}).success).toBe(false);
  });
  it('TemplateIdArg requires positive int id', () => {
    expect(TemplateIdArg.safeParse({ id: 5 }).success).toBe(true);
    expect(TemplateIdArg.safeParse({ id: -1 }).success).toBe(false);
    expect(TemplateIdArg.safeParse({ id: 0 }).success).toBe(false);
  });
  it('CreateDomainTokenArgs requires domain + zone_provider', () => {
    expect(
      CreateDomainTokenArgs.safeParse({ domain: 'x.com', zone_provider: 'openprovider' }).success,
    ).toBe(true);
    expect(CreateDomainTokenArgs.safeParse({ domain: 'x.com' }).success).toBe(false);
  });
});

describe('batch3 catalog+tags schemas', () => {
  it('TldNameArg requires name', () => {
    expect(TldNameArg.safeParse({ name: 'com' }).success).toBe(true);
    expect(TldNameArg.safeParse({}).success).toBe(false);
  });
  it('GetDomainPriceArgs requires domain+operation; additional_data.idn_script optional', () => {
    expect(
      GetDomainPriceArgs.safeParse({ domain: { name: 'x', extension: 'com' }, operation: 'create' })
        .success,
    ).toBe(true);
    expect(
      GetDomainPriceArgs.safeParse({
        domain: { name: 'x', extension: 'com' },
        operation: 'renew',
        additional_data: { idn_script: 'cyrl' },
      }).success,
    ).toBe(true);
    expect(GetDomainPriceArgs.safeParse({ domain: { name: 'x', extension: 'com' } }).success).toBe(
      false,
    );
    expect(
      GetDomainPriceArgs.safeParse({ domain: { name: 'x', extension: 'com' }, operation: 'bogus' })
        .success,
    ).toBe(false);
  });
  it('CreateTagArgs requires key+value', () => {
    expect(CreateTagArgs.safeParse({ key: 'customer', value: 'Tech' }).success).toBe(true);
    expect(CreateTagArgs.safeParse({ key: 'customer' }).success).toBe(false);
    expect(CreateTagArgs.safeParse({ value: 'Tech' }).success).toBe(false);
  });
  it('DeleteTagArgs requires key+value', () => {
    expect(DeleteTagArgs.safeParse({ key: 'customer', value: 'Tech' }).success).toBe(true);
    expect(DeleteTagArgs.safeParse({}).success).toBe(false);
  });
});

describe('batch4 SSL schemas', () => {
  const validOrderBody = {
    approver_email: 'a@b.c',
    autorenew: 'on' as const,
    csr: 'PEM',
    domain_amount: 1,
    domain_validation_methods: [{ host_name: 'x.com', method: 'dns' as const }],
    enable_dns_automation: false,
    host_names: ['x.com'],
    organization_handle: 'OH',
    period: 1,
    product_id: 1,
    signature_hash_algorithm: 'sha2',
    software_id: 'linux',
    start_provision: true,
    technical_handle: 'TH',
    wildcard_domain_amount: 0,
  };

  it('SslOrderIdArg requires positive int id', () => {
    expect(SslOrderIdArg.safeParse({ id: 1 }).success).toBe(true);
    expect(SslOrderIdArg.safeParse({ id: 0 }).success).toBe(false);
    expect(SslOrderIdArg.safeParse({}).success).toBe(false);
  });

  it('SslProductIdArg requires positive int id', () => {
    expect(SslProductIdArg.safeParse({ id: 42 }).success).toBe(true);
    expect(SslProductIdArg.safeParse({ id: -1 }).success).toBe(false);
    expect(SslProductIdArg.safeParse({}).success).toBe(false);
  });

  it('GetSslApproverEmailsArgs requires domain string', () => {
    expect(GetSslApproverEmailsArgs.safeParse({ domain: 'x.com' }).success).toBe(true);
    expect(GetSslApproverEmailsArgs.safeParse({ domain: '' }).success).toBe(false);
    expect(GetSslApproverEmailsArgs.safeParse({}).success).toBe(false);
  });

  it('CreateSslOrderArgs requires the full order body', () => {
    expect(CreateSslOrderArgs.safeParse(validOrderBody).success).toBe(true);
    expect(
      CreateSslOrderArgs.safeParse({ ...validOrderBody, approver_email: undefined }).success,
    ).toBe(false);
    expect(CreateSslOrderArgs.safeParse({ ...validOrderBody, autorenew: 'maybe' }).success).toBe(
      false,
    );
  });

  it('CreateSslOrderArgs rejects empty domain_validation_methods', () => {
    expect(
      CreateSslOrderArgs.safeParse({ ...validOrderBody, domain_validation_methods: [] }).success,
    ).toBe(false);
  });

  it('CreateSslOrderArgs rejects invalid method in domain_validation_methods', () => {
    expect(
      CreateSslOrderArgs.safeParse({
        ...validOrderBody,
        domain_validation_methods: [{ host_name: 'x.com', method: 'ftp' }],
      }).success,
    ).toBe(false);
  });

  it('UpdateSslOrderArgs requires id + full body', () => {
    expect(UpdateSslOrderArgs.safeParse({ ...validOrderBody, id: 99 }).success).toBe(true);
    expect(UpdateSslOrderArgs.safeParse(validOrderBody).success).toBe(false); // missing id
    expect(UpdateSslOrderArgs.safeParse({ id: 99 }).success).toBe(false); // missing body fields
  });

  it('ReissueSslOrderArgs requires id + full body', () => {
    expect(ReissueSslOrderArgs.safeParse({ ...validOrderBody, id: 7 }).success).toBe(true);
    expect(ReissueSslOrderArgs.safeParse(validOrderBody).success).toBe(false);
  });

  it('RenewSslOrderArgs requires id + enable_dns_automation', () => {
    expect(RenewSslOrderArgs.safeParse({ id: 1, enable_dns_automation: false }).success).toBe(true);
    expect(RenewSslOrderArgs.safeParse({ id: 1 }).success).toBe(false);
    expect(RenewSslOrderArgs.safeParse({ enable_dns_automation: true }).success).toBe(false);
  });

  it('CancelSslOrderArgs requires id', () => {
    expect(CancelSslOrderArgs.safeParse({ id: 5 }).success).toBe(true);
    expect(CancelSslOrderArgs.safeParse({}).success).toBe(false);
    expect(CancelSslOrderArgs.safeParse({ id: 0 }).success).toBe(false);
  });

  it('UpdateSslApproverEmailArgs requires id + approver_email', () => {
    expect(UpdateSslApproverEmailArgs.safeParse({ id: 1, approver_email: 'a@b.c' }).success).toBe(
      true,
    );
    expect(UpdateSslApproverEmailArgs.safeParse({ id: 1 }).success).toBe(false);
    expect(UpdateSslApproverEmailArgs.safeParse({ approver_email: 'a@b.c' }).success).toBe(false);
  });

  it('ResendSslApproverEmailArgs requires id', () => {
    expect(ResendSslApproverEmailArgs.safeParse({ id: 3 }).success).toBe(true);
    expect(ResendSslApproverEmailArgs.safeParse({}).success).toBe(false);
  });

  it('CreateCsrArgs requires bits/CN/country/email/locality/organization/sig_algo/state', () => {
    const valid = {
      bits: 2048,
      common_name: 'x.com',
      country: 'NL',
      email: 'a@b.c',
      locality: 'Amsterdam',
      organization: 'X',
      signature_hash_algorithm: 'sha2',
      state: 'NH',
    };
    expect(CreateCsrArgs.safeParse(valid).success).toBe(true);
    expect(CreateCsrArgs.safeParse({ ...valid, country: 'NLD' }).success).toBe(false); // >2 chars
    expect(CreateCsrArgs.safeParse({ ...valid, bits: undefined }).success).toBe(false);
    expect(CreateCsrArgs.safeParse({ ...valid, common_name: '' }).success).toBe(false);
  });

  it('CreateCsrArgs accepts optional fields', () => {
    const valid = {
      bits: 4096,
      common_name: 'y.com',
      country: 'DE',
      email: 'x@y.z',
      locality: 'Berlin',
      organization: 'Y',
      signature_hash_algorithm: 'sha256',
      state: 'BE',
      subject_alternative_name: ['san.y.com'],
      unit: 'IT',
      with_config: true,
    };
    expect(CreateCsrArgs.safeParse(valid).success).toBe(true);
  });

  it('DecodeCsrArgs requires csr', () => {
    expect(DecodeCsrArgs.safeParse({ csr: 'PEM' }).success).toBe(true);
    expect(DecodeCsrArgs.safeParse({ csr: '' }).success).toBe(false);
    expect(DecodeCsrArgs.safeParse({}).success).toBe(false);
  });

  it('CreateSslOtpTokenArgs requires id', () => {
    expect(CreateSslOtpTokenArgs.safeParse({ id: 10 }).success).toBe(true);
    expect(CreateSslOtpTokenArgs.safeParse({ id: 0 }).success).toBe(false);
    expect(CreateSslOtpTokenArgs.safeParse({}).success).toBe(false);
  });
});

describe('batch5 customer schemas', () => {
  it('CustomerHandleArg requires handle', () => {
    expect(CustomerHandleArg.safeParse({ handle: 'JD123-NL' }).success).toBe(true);
    expect(CustomerHandleArg.safeParse({}).success).toBe(false);
  });
  it('CreateCustomerArgs requires email+username+name+address+phone', () => {
    const valid = {
      email: 'a@b.c',
      username: 'usr',
      name: { first_name: 'F', last_name: 'L' },
      address: { street: 'St', number: '1', city: 'C', zipcode: 'Z', country: 'NL' },
      phone: { country_code: '+1', area_code: '555', subscriber_number: '1234567' },
    };
    expect(CreateCustomerArgs.safeParse(valid).success).toBe(true);
    // missing email
    expect(CreateCustomerArgs.safeParse({ ...valid, email: undefined }).success).toBe(false);
    // missing address.country
    expect(
      CreateCustomerArgs.safeParse({
        ...valid,
        address: { street: 'St', number: '1', city: 'C', zipcode: 'Z' },
      }).success,
    ).toBe(false);
  });
  it('CreateCustomerArgs rejects 3-letter country code', () => {
    const base = {
      email: 'a@b.c',
      username: 'usr',
      name: { first_name: 'F', last_name: 'L' },
      phone: { country_code: '+1', area_code: '555', subscriber_number: '1234567' },
    };
    expect(
      CreateCustomerArgs.safeParse({
        ...base,
        address: { street: 'St', number: '1', city: 'C', zipcode: 'Z', country: 'NLD' },
      }).success,
    ).toBe(false);
  });
  it('UpdateCustomerArgs accepts handle alone (partial update)', () => {
    expect(UpdateCustomerArgs.safeParse({ handle: 'JD123-NL' }).success).toBe(true);
    // handle is required even on update
    expect(UpdateCustomerArgs.safeParse({}).success).toBe(false);
  });
  it('UpdateCustomerArgs accepts partial nested updates', () => {
    expect(UpdateCustomerArgs.safeParse({ handle: 'JD123-NL', email: 'new@b.c' }).success).toBe(
      true,
    );
    expect(
      UpdateCustomerArgs.safeParse({ handle: 'JD123-NL', name: { first_name: 'X' } }).success,
    ).toBe(true);
  });
});

describe('batch6 email schemas', () => {
  it('EmailTemplateIdArg requires positive int id', () => {
    expect(EmailTemplateIdArg.safeParse({ id: 1 }).success).toBe(true);
    expect(EmailTemplateIdArg.safeParse({ id: 0 }).success).toBe(false);
    expect(EmailTemplateIdArg.safeParse({}).success).toBe(false);
  });

  it('EasyDmarcIdArg requires positive int id', () => {
    expect(EasyDmarcIdArg.safeParse({ id: 1 }).success).toBe(true);
    expect(EasyDmarcIdArg.safeParse({ id: -1 }).success).toBe(false);
    expect(EasyDmarcIdArg.safeParse({}).success).toBe(false);
  });

  it('SpamExpertsDomainArg requires domain_name', () => {
    expect(SpamExpertsDomainArg.safeParse({ domain_name: 'x.com' }).success).toBe(true);
    expect(SpamExpertsDomainArg.safeParse({}).success).toBe(false);
  });

  it('GetDmarcArgs requires domain.name + domain.extension', () => {
    expect(GetDmarcArgs.safeParse({ domain: { name: 'x', extension: 'com' } }).success).toBe(true);
    expect(GetDmarcArgs.safeParse({}).success).toBe(false);
  });

  it('CreateEmailTemplateArgs requires group+name', () => {
    expect(CreateEmailTemplateArgs.safeParse({ group: 'ive', name: 'tpl' }).success).toBe(true);
    expect(CreateEmailTemplateArgs.safeParse({ group: 'ive' }).success).toBe(false);
  });

  it('UpdateEmailTemplateArgs requires id+group+name', () => {
    expect(UpdateEmailTemplateArgs.safeParse({ id: 1, group: 'ive', name: 'tpl' }).success).toBe(
      true,
    );
    expect(UpdateEmailTemplateArgs.safeParse({ group: 'ive', name: 'tpl' }).success).toBe(false);
  });

  it('StartEmailVerificationArgs requires email + handle', () => {
    expect(StartEmailVerificationArgs.safeParse({ email: 'a@b.c', handle: 'JD-NL' }).success).toBe(
      true,
    );
    expect(StartEmailVerificationArgs.safeParse({ email: 'a@b.c' }).success).toBe(false);
  });

  it('RestartEmailVerificationArgs same as start', () => {
    expect(
      RestartEmailVerificationArgs.safeParse({ email: 'a@b.c', handle: 'JD-NL' }).success,
    ).toBe(true);
    expect(RestartEmailVerificationArgs.safeParse({ handle: 'JD-NL' }).success).toBe(false);
  });

  it('CreateDmarcArgs requires domain + owner_handle', () => {
    expect(
      CreateDmarcArgs.safeParse({ domain: { name: 'x', extension: 'com' }, owner_handle: 'OH' })
        .success,
    ).toBe(true);
    expect(CreateDmarcArgs.safeParse({ domain: { name: 'x', extension: 'com' } }).success).toBe(
      false,
    );
  });

  it('RetryDmarcArgs / DmarcSsoLoginArgs / EmailTemplateIdArg / EasyDmarcIdArg require positive int id', () => {
    expect(RetryDmarcArgs.safeParse({ id: 1 }).success).toBe(true);
    expect(RetryDmarcArgs.safeParse({}).success).toBe(false);
    expect(DmarcSsoLoginArgs.safeParse({ id: 1 }).success).toBe(true);
    expect(EmailTemplateIdArg.safeParse({ id: 1 }).success).toBe(true);
    expect(EasyDmarcIdArg.safeParse({ id: 1 }).success).toBe(true);
  });

  it('DmarcSsoLoginArgs requires positive int id', () => {
    expect(DmarcSsoLoginArgs.safeParse({ id: 5 }).success).toBe(true);
    expect(DmarcSsoLoginArgs.safeParse({ id: 0 }).success).toBe(false);
    expect(DmarcSsoLoginArgs.safeParse({}).success).toBe(false);
  });

  it('SpamExpertsLoginUrlArgs requires bundle + domain_or_email', () => {
    expect(
      SpamExpertsLoginUrlArgs.safeParse({ bundle: false, domain_or_email: 'a@b.c' }).success,
    ).toBe(true);
    expect(SpamExpertsLoginUrlArgs.safeParse({ bundle: false }).success).toBe(false);
  });

  it('CreateSpamExpertsDomainArgs.aliases is a flat string array', () => {
    const valid = {
      bundle: true,
      destinations: [{ hostname: 'h', port: 25 }],
      domain_name: 'x.com',
      products: { archiving: false, incoming: true, outgoing: false },
    };
    expect(
      CreateSpamExpertsDomainArgs.safeParse({ ...valid, aliases: ['a.com', 'b.com'] }).success,
    ).toBe(true);
    // object form invalid on create
    expect(
      CreateSpamExpertsDomainArgs.safeParse({ ...valid, aliases: { add: ['a.com'] } }).success,
    ).toBe(false);
  });

  it('UpdateSpamExpertsDomainArgs.aliases is an {add,remove} object', () => {
    const valid = {
      bundle: true,
      destinations: [{ hostname: 'h', port: 25 }],
      domain_name: 'x.com',
      products: { archiving: false, incoming: true, outgoing: false },
    };
    expect(
      UpdateSpamExpertsDomainArgs.safeParse({ ...valid, aliases: { add: ['a.com'] } }).success,
    ).toBe(true);
    // array form invalid on update
    expect(UpdateSpamExpertsDomainArgs.safeParse({ ...valid, aliases: ['a.com'] }).success).toBe(
      false,
    );
  });
});

import {
  PleskKeyIdArg,
  CreatePleskLicenseArgs,
  UpdatePleskLicenseArgs,
  ResetPleskHwidArgs,
} from './types.js';

describe('batch7 license schemas', () => {
  it('PleskKeyIdArg requires positive int key_id', () => {
    expect(PleskKeyIdArg.safeParse({ key_id: 1 }).success).toBe(true);
    expect(PleskKeyIdArg.safeParse({ key_id: -1 }).success).toBe(false);
    expect(PleskKeyIdArg.safeParse({}).success).toBe(false);
  });
  it('CreatePleskLicenseArgs requires items/period/ip_address_binding/title', () => {
    const valid = { items: ['SKU'], period: 1, ip_address_binding: '127.0.0.1', title: 'T' };
    expect(CreatePleskLicenseArgs.safeParse(valid).success).toBe(true);
    expect(CreatePleskLicenseArgs.safeParse({ ...valid, items: [] }).success).toBe(false); // min(1)
    expect(CreatePleskLicenseArgs.safeParse({ ...valid, period: -1 }).success).toBe(false);
    expect(CreatePleskLicenseArgs.safeParse({ items: ['SKU'], period: 1 }).success).toBe(false); // missing ip+title
  });
  it('CreatePleskLicenseArgs accepts optional fields', () => {
    expect(
      CreatePleskLicenseArgs.safeParse({
        items: ['SKU'],
        period: 1,
        ip_address_binding: '127.0.0.1',
        title: 'T',
        comment: 'c',
        parent_key_id: 0,
        restrict_ip_binding: false,
        attached_keys: [],
      }).success,
    ).toBe(true);
  });
  it('UpdatePleskLicenseArgs requires key_id + body', () => {
    const body = { items: ['SKU'], period: 1, ip_address_binding: '127.0.0.1', title: 'T' };
    expect(UpdatePleskLicenseArgs.safeParse({ key_id: 1, ...body }).success).toBe(true);
    expect(UpdatePleskLicenseArgs.safeParse(body).success).toBe(false); // missing key_id
  });
  it('ResetPleskHwidArgs requires key_id + product', () => {
    expect(ResetPleskHwidArgs.safeParse({ key_id: 1, product: 'plesk' }).success).toBe(true);
    expect(ResetPleskHwidArgs.safeParse({ key_id: 1 }).success).toBe(false);
    expect(ResetPleskHwidArgs.safeParse({ product: 'plesk' }).success).toBe(false);
  });
});
