import { describe, expect, it } from 'vitest';
import { canChangeCreditTerms, canConvertProspect, canCreatePartnerKind, canLogActivity, canManagePartnerKind, PARTNER_CREATE_ROLES } from './partner-access';

describe('canCreatePartnerKind', () => {
  it('lets the accountant add a customer while issuing a sales slip', () => {
    expect(PARTNER_CREATE_ROLES).toContain('ACCOUNTANT');
    expect(canCreatePartnerKind(['ACCOUNTANT'], 'CUSTOMER')).toBe(true);
  });

  it('keeps suppliers with procurement / catalog managers', () => {
    expect(canCreatePartnerKind(['ACCOUNTANT'], 'SUPPLIER')).toBe(false);
    expect(canCreatePartnerKind(['ACCOUNTANT'], 'BOTH')).toBe(false);
    expect(canCreatePartnerKind(['PROCUREMENT_MANAGER'], 'SUPPLIER')).toBe(true);
    expect(canCreatePartnerKind(['SALES_MANAGER'], 'CUSTOMER')).toBe(true);
  });

  it('lets sales reps add prospects only', () => {
    expect(PARTNER_CREATE_ROLES).toContain('SALES');
    expect(canCreatePartnerKind(['SALES'], 'CUSTOMER', 'PROSPECT')).toBe(true);
    expect(canCreatePartnerKind(['SALES'], 'CUSTOMER', 'CUSTOMER')).toBe(false);
    expect(canCreatePartnerKind(['SALES'], 'SUPPLIER', 'PROSPECT')).toBe(false);
    expect(canConvertProspect(['SALES'])).toBe(false);
    expect(canConvertProspect(['SALES_MANAGER'])).toBe(true);
    expect(canLogActivity(['SALES'])).toBe(true);
    expect(canLogActivity(['WAREHOUSE'])).toBe(false);
  });

  it('does not open partner creation to other roles', () => {
    expect(canCreatePartnerKind(['SALES'], 'CUSTOMER')).toBe(false);
    expect(canCreatePartnerKind(['WAREHOUSE'], 'CUSTOMER')).toBe(false);
  });

  it('lets the director manage every partner and warehouse accounts manage suppliers only', () => {
    expect(canManagePartnerKind(['DIRECTOR'], 'CUSTOMER')).toBe(true);
    expect(canManagePartnerKind(['WAREHOUSE'], 'SUPPLIER')).toBe(true);
    expect(canManagePartnerKind(['WAREHOUSE_MANAGER'], 'CUSTOMER')).toBe(false);
    expect(canManagePartnerKind(['ACCOUNTANT'], 'CUSTOMER')).toBe(false);
  });

  it('keeps credit terms with the director, accountant and admin', () => {
    expect(canChangeCreditTerms(['DIRECTOR'])).toBe(true);
    expect(canChangeCreditTerms(['ACCOUNTANT'])).toBe(true);
    expect(canChangeCreditTerms(['SALES_MANAGER'])).toBe(false);
  });
});
