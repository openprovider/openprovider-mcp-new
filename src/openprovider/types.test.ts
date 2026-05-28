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
