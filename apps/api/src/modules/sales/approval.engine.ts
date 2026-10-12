import Decimal from 'decimal.js';

export interface ApprovalEvaluationInput {
  orderTotal: string;
  highestDiscountRate: string;
  currentExposure: string;
  creditLimit: string;
  orderApprovalThreshold: string;
  discountApprovalThreshold: string;
}

export interface ApprovalEvaluation {
  required: boolean;
  reasons: string[];
}

export function evaluateApproval(input: ApprovalEvaluationInput): ApprovalEvaluation {
  const reasons: string[] = [];
  if (new Decimal(input.orderTotal).gte(input.orderApprovalThreshold)) reasons.push('ORDER_VALUE_THRESHOLD');
  if (new Decimal(input.highestDiscountRate).gt(input.discountApprovalThreshold)) reasons.push('DISCOUNT_THRESHOLD');
  // Hạn mức 0 = không cấp công nợ cho khách (thanh toán ngay), không phải hạn mức bị vượt cần duyệt.
  const creditLimit = new Decimal(input.creditLimit);
  if (creditLimit.gt(0) && new Decimal(input.currentExposure).add(input.orderTotal).gt(creditLimit)) reasons.push('CREDIT_LIMIT_EXCEEDED');
  return { required: reasons.length > 0, reasons };
}
