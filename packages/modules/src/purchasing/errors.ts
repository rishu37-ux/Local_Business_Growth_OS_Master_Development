// Purchasing rule violations, mapped to HTTP by the API.
import type { PurchaseProblem } from './problems.ts';

export type PurchasingErrorCode =
  | 'NOT_FOUND'
  | 'GSTIN_INVALID'
  | 'INVALID_LINE'
  | 'NOT_DRAFT'
  | 'NOT_POSTED'
  | 'BLOCKING_PROBLEMS'
  | 'DUPLICATE_SUPPLIER_INVOICE'
  | 'IMEI_TAKEN'
  | 'REVERSAL_BLOCKED'
  | 'INSUFFICIENT_STOCK';

export class PurchasingError extends Error {
  readonly code: PurchasingErrorCode;
  readonly field: string | undefined;
  readonly problems: readonly PurchaseProblem[];

  constructor(code: PurchasingErrorCode, message: string, field?: string, problems: readonly PurchaseProblem[] = []) {
    super(message);
    this.name = 'PurchasingError';
    this.code = code;
    this.field = field;
    this.problems = problems;
  }
}
