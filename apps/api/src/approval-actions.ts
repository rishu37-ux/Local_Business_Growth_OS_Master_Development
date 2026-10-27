// Approval actions by type: each module that raises approval requests
// supplies the executor (and any check on the approver) for its actions.
import type { ApprovalAction, ApprovalExecutor } from '@lbgos/modules/approvals';
import { ADJUSTMENT_ACTION, adjustmentExecutor } from '@lbgos/modules/inventory';
import { DISCOUNT_ACTION, discountApprovalAction } from '@lbgos/modules/sales';

export const APPROVAL_ACTIONS: Readonly<Record<string, ApprovalExecutor | ApprovalAction>> = {
  [ADJUSTMENT_ACTION]: adjustmentExecutor,
  [DISCOUNT_ACTION]: discountApprovalAction,
};
