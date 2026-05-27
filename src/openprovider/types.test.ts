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
