import { describe, expect, it } from 'vitest';
import { evaluateApproval } from './approval.engine';

describe('evaluateApproval', () => {
  it('requires approval for every matching exception', () => {
    const result = evaluateApproval({
      orderTotal: '120000000',
      highestDiscountRate: '19',
      currentExposure: '50000000',
      creditLimit: '100000000',
      orderApprovalThreshold: '100000000',
      discountApprovalThreshold: '15',
    });
    expect(result.required).toBe(true);
    expect(result.reasons).toEqual([
      'ORDER_VALUE_THRESHOLD',
      'DISCOUNT_THRESHOLD',
      'CREDIT_LIMIT_EXCEEDED',
    ]);
  });

  it('treats a zero credit limit as "no credit granted", not as an exceeded limit', () => {
    const result = evaluateApproval({
      orderTotal: '152000',
      highestDiscountRate: '0',
      currentExposure: '0',
      creditLimit: '0',
      orderApprovalThreshold: '100000000',
      discountApprovalThreshold: '15',
    });
    expect(result).toEqual({ required: false, reasons: [] });
  });

  it('still applies the order value threshold to customers without credit', () => {
    expect(
      evaluateApproval({
        orderTotal: '150000000',
        highestDiscountRate: '0',
        currentExposure: '0',
        creditLimit: '0',
        orderApprovalThreshold: '100000000',
        discountApprovalThreshold: '15',
      }).reasons,
    ).toEqual(['ORDER_VALUE_THRESHOLD']);
  });

  it('allows a normal order to reserve automatically', () => {
    expect(
      evaluateApproval({
        orderTotal: '10000000',
        highestDiscountRate: '8',
        currentExposure: '0',
        creditLimit: '50000000',
        orderApprovalThreshold: '100000000',
        discountApprovalThreshold: '15',
      }).required,
    ).toBe(false);
  });
});
