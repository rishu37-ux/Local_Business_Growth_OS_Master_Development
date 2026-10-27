// Payment allocation (FR-LED-2, D-014). Pure: callers pass open invoices and
// the unallocated parts of payments; the result says which payment covers
// which invoice by how much. Anything not allocated stays on the payment as
// customer advance. Amounts are integer paise.

export interface OpenInvoice {
  readonly id: string;
  /** yyyy-mm-dd */
  readonly date: string;
  readonly number: string;
  /** Total − allocations − credit notes; > 0 for an open invoice. */
  readonly outstandingPaise: number;
}

export interface PaymentFunds {
  readonly id: string;
  /** Not yet allocated to any invoice (customer advance held on this payment). */
  readonly unallocatedPaise: number;
}

export interface Allocation {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountPaise: number;
}

export class AllocationError extends Error {
  readonly code: 'UNKNOWN_INVOICE' | 'INSUFFICIENT_ADVANCE' | 'INVALID_AMOUNT';

  constructor(code: AllocationError['code'], message: string) {
    super(message);
    this.name = 'AllocationError';
    this.code = code;
  }
}

const numberCollator = new Intl.Collator('en', { numeric: true });

/** FIFO order: oldest invoice date first, then invoice number (numeric-aware). */
export function fifoOrder<T extends OpenInvoice>(invoices: readonly T[]): T[] {
  return [...invoices].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : numberCollator.compare(a.number, b.number),
  );
}

function checkAmount(v: number): void {
  if (!Number.isSafeInteger(v) || v < 0)
    throw new AllocationError('INVALID_AMOUNT', 'amounts must be non-negative integers');
}

/**
 * Allocates the funds of `payments` (used oldest first, in the order given) to
 * `invoices`: to `selectedInvoiceIds` in that order when given, otherwise FIFO
 * over all open invoices (D-014). Never allocates more than an invoice's
 * outstanding amount or a payment's unallocated amount.
 */
export function allocate(
  payments: readonly PaymentFunds[],
  invoices: readonly OpenInvoice[],
  selectedInvoiceIds?: readonly string[],
): Allocation[] {
  for (const p of payments) checkAmount(p.unallocatedPaise);
  for (const i of invoices) checkAmount(i.outstandingPaise);
  let targets: OpenInvoice[];
  if (selectedInvoiceIds && selectedInvoiceIds.length > 0) {
    targets = selectedInvoiceIds.map((id) => {
      const inv = invoices.find((i) => i.id === id);
      if (!inv) throw new AllocationError('UNKNOWN_INVOICE', `invoice ${id} is not open for this customer`);
      return inv;
    });
  } else {
    targets = fifoOrder(invoices);
  }
  const funds = payments.map((p) => ({ id: p.id, left: p.unallocatedPaise }));
  const out: Allocation[] = [];
  for (const inv of targets) {
    let due = inv.outstandingPaise;
    for (const f of funds) {
      if (due === 0) break;
      if (f.left === 0) continue;
      const amount = Math.min(due, f.left);
      out.push({ paymentId: f.id, invoiceId: inv.id, amountPaise: amount });
      f.left -= amount;
      due -= amount;
    }
  }
  return out;
}

/** Which payments' advance a refund of `amountPaise` uses (oldest first). */
export function refundSources(
  payments: readonly PaymentFunds[],
  amountPaise: number,
): { paymentId: string; amountPaise: number }[] {
  checkAmount(amountPaise);
  const available = payments.reduce((s, p) => s + p.unallocatedPaise, 0);
  if (amountPaise === 0 || amountPaise > available) {
    throw new AllocationError('INSUFFICIENT_ADVANCE', 'The refund is larger than the advance held.');
  }
  const out: { paymentId: string; amountPaise: number }[] = [];
  let left = amountPaise;
  for (const p of payments) {
    if (left === 0) break;
    const take = Math.min(left, p.unallocatedPaise);
    if (take > 0) out.push({ paymentId: p.id, amountPaise: take });
    left -= take;
  }
  return out;
}

export type PaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

/** Derived from allocations and credit notes (WORKFLOWS §6). */
export function paymentStatus(totalPaise: number, allocatedPaise: number, creditedPaise = 0): PaymentStatus {
  const covered = allocatedPaise + creditedPaise;
  if (covered >= totalPaise) return 'PAID';
  if (allocatedPaise > 0) return 'PARTIALLY_PAID';
  return 'UNPAID';
}
