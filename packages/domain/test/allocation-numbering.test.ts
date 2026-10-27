import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocate,
  AllocationError,
  fifoOrder,
  formatProblem,
  METRICS,
  NumberingError,
  paymentStatus,
  refundSources,
  renderInvoiceNumber,
  type OpenInvoice,
} from '../src/index.ts';

const inv = (id: string, date: string, number: string, outstandingPaise: number): OpenInvoice => ({
  id,
  date,
  number,
  outstandingPaise,
});

describe('allocation (FR-LED-2, D-014)', () => {
  const open = [
    inv('b', '2026-10-02', 'T/9', 5000),
    inv('a', '2026-10-01', 'T/10', 3000),
    inv('c', '2026-10-02', 'T/10', 2000),
  ];

  it('FIFO: oldest date first, then invoice number (numeric-aware)', () => {
    expect(fifoOrder(open).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('exact payment covers one invoice', () => {
    expect(allocate([{ id: 'p', unallocatedPaise: 3000 }], open)).toEqual([
      { paymentId: 'p', invoiceId: 'a', amountPaise: 3000 },
    ]);
  });

  it('partial payment covers part of the oldest invoice', () => {
    expect(allocate([{ id: 'p', unallocatedPaise: 1000 }], open)).toEqual([
      { paymentId: 'p', invoiceId: 'a', amountPaise: 1000 },
    ]);
  });

  it('a payment spills over several invoices in FIFO order; the remainder stays as advance', () => {
    const out = allocate([{ id: 'p', unallocatedPaise: 12_000 }], open);
    expect(out).toEqual([
      { paymentId: 'p', invoiceId: 'a', amountPaise: 3000 },
      { paymentId: 'p', invoiceId: 'b', amountPaise: 5000 },
      { paymentId: 'p', invoiceId: 'c', amountPaise: 2000 },
    ]);
    expect(12_000 - out.reduce((s, a) => s + a.amountPaise, 0)).toBe(2000); // advance
  });

  it('explicit invoice selection is honoured in the order given', () => {
    expect(allocate([{ id: 'p', unallocatedPaise: 6000 }], open, ['c', 'b'])).toEqual([
      { paymentId: 'p', invoiceId: 'c', amountPaise: 2000 },
      { paymentId: 'p', invoiceId: 'b', amountPaise: 4000 },
    ]);
    expect(() => allocate([{ id: 'p', unallocatedPaise: 1 }], open, ['zzz'])).toThrow(AllocationError);
  });

  it('applying held advances (several payments, oldest first) to a new invoice', () => {
    const out = allocate(
      [
        { id: 'old', unallocatedPaise: 700 },
        { id: 'new', unallocatedPaise: 500 },
      ],
      [inv('n', '2026-10-05', 'T/11', 1000)],
    );
    expect(out).toEqual([
      { paymentId: 'old', invoiceId: 'n', amountPaise: 700 },
      { paymentId: 'new', invoiceId: 'n', amountPaise: 300 },
    ]);
  });

  it('refunds of advance draw on the oldest payments and cannot exceed the advance', () => {
    const funds = [
      { id: 'p1', unallocatedPaise: 300 },
      { id: 'p2', unallocatedPaise: 0 },
      { id: 'p3', unallocatedPaise: 500 },
    ];
    expect(refundSources(funds, 600)).toEqual([
      { paymentId: 'p1', amountPaise: 300 },
      { paymentId: 'p3', amountPaise: 300 },
    ]);
    expect(() => refundSources(funds, 801)).toThrow(/larger than the advance/);
    expect(() => refundSources(funds, 0)).toThrow(AllocationError);
  });

  it('payment status is derived from allocations and credit notes', () => {
    expect(paymentStatus(1000, 0)).toBe('UNPAID');
    expect(paymentStatus(1000, 400)).toBe('PARTIALLY_PAID');
    expect(paymentStatus(1000, 1000)).toBe('PAID');
    expect(paymentStatus(1000, 600, 400)).toBe('PAID');
    expect(paymentStatus(1000, 0, 300)).toBe('UNPAID');
    expect(paymentStatus(0, 0)).toBe('PAID');
  });

  it('rejects negative or fractional amounts', () => {
    expect(() => allocate([{ id: 'p', unallocatedPaise: -1 }], open)).toThrow(AllocationError);
    expect(() => allocate([{ id: 'p', unallocatedPaise: 1 }], [inv('x', '2026-01-01', '1', 0.5)])).toThrow(
      AllocationError,
    );
  });

  it('never over-allocates an invoice or a payment (property)', () => {
    const invoices = fc.uniqueArray(
      fc.record({
        id: fc.uuid(),
        date: fc.constantFrom('2026-04-01', '2026-05-01', '2026-06-01'),
        number: fc.stringMatching(/^[A-Z]\/[0-9]{1,4}$/),
        outstandingPaise: fc.integer({ min: 0, max: 1e7 }),
      }),
      { selector: (i) => i.id, maxLength: 20 },
    );
    const payments = fc.uniqueArray(fc.record({ id: fc.uuid(), unallocatedPaise: fc.integer({ min: 0, max: 2e7 }) }), {
      selector: (p) => p.id,
      maxLength: 5,
    });
    fc.assert(
      fc.property(invoices, payments, (invs, pays) => {
        const out = allocate(pays, invs);
        const byInv = new Map<string, number>();
        const byPay = new Map<string, number>();
        for (const a of out) {
          byInv.set(a.invoiceId, (byInv.get(a.invoiceId) ?? 0) + a.amountPaise);
          byPay.set(a.paymentId, (byPay.get(a.paymentId) ?? 0) + a.amountPaise);
        }
        const totalFunds = pays.reduce((s, p) => s + p.unallocatedPaise, 0);
        const totalDue = invs.reduce((s, i) => s + i.outstandingPaise, 0);
        const allocated = out.reduce((s, a) => s + a.amountPaise, 0);
        return (
          out.every((a) => a.amountPaise > 0) &&
          invs.every((i) => (byInv.get(i.id) ?? 0) <= i.outstandingPaise) &&
          pays.every((p) => (byPay.get(p.id) ?? 0) <= p.unallocatedPaise) &&
          allocated === Math.min(totalFunds, totalDue)
        );
      }),
    );
  });
});

describe('invoice number formats (FR-POS-4 AC3, D-012)', () => {
  it('renders tokens; the default fits a 6-character prefix in 16 characters', () => {
    expect(renderInvoiceNumber('{PREFIX}{FY}/{SEQ:4}', 'EXMOB1', '2026-27', 42)).toBe('EXMOB126-27/0042');
    expect(renderInvoiceNumber('{PREFIX}{FY}/{SEQ:4}', '', '2026-27', 1)).toBe('26-27/0001');
    expect(renderInvoiceNumber('{FYLONG}/{SEQ:5}', '', '2026-27', 7)).toBe('2026-27/00007');
  });

  it('refuses formats that could exceed 16 characters or contain other characters, at configuration time', () => {
    expect(formatProblem('{PREFIX}/{FYLONG}/{SEQ:6}', 'EXMOB1')).toBe('TOO_LONG');
    expect(formatProblem('{PREFIX} {SEQ:4}', 'A')).toBe('BAD_CHARACTERS');
    expect(formatProblem('{SEQ:4}', 'A B')).toBe('BAD_CHARACTERS');
    expect(formatProblem('{PREFIX}{FY}', 'A')).toBe('NO_SEQUENCE');
    expect(formatProblem('{SEQ:2}{SEQ:3}', '')).toBe('MULTIPLE_SEQUENCES');
    expect(formatProblem('{DATE}/{SEQ:4}', '')).toBe('UNKNOWN_TOKEN');
    expect(formatProblem('{SEQ:9}', '')).toBe('NO_SEQUENCE');
    expect(formatProblem('{PREFIX}{FY}/{SEQ:4}', 'EXMOB1')).toBeNull();
    expect(() => renderInvoiceNumber('{PREFIX}', 'A', '2026-27', 1)).toThrow(NumberingError);
  });

  it('a sequence that outgrows its digits is exhausted rather than lengthening the number', () => {
    expect(renderInvoiceNumber('{SEQ:2}', '', '2026-27', 99)).toBe('99');
    expect(() => renderInvoiceNumber('{SEQ:2}', '', '2026-27', 100)).toThrow(/no 2-digit numbers left/);
    expect(() => renderInvoiceNumber('{SEQ:2}', '', '2026-27', 0)).toThrow(RangeError);
    expect(() => renderInvoiceNumber('{SEQ:2}', '', '26-27', 1)).toThrow(RangeError);
  });

  it('every number any valid format renders is ≤ 16 allowed characters (property)', () => {
    const token = fc.constantFrom('{PREFIX}', '{FY}', '{FYLONG}', '/', '-', 'INV', 'S');
    fc.assert(
      fc.property(
        fc.array(token, { maxLength: 5 }),
        fc.integer({ min: 1, max: 8 }),
        fc.stringMatching(/^[A-Z0-9/-]{0,6}$/),
        fc.integer({ min: 1, max: 99_999_999 }),
        (parts, digits, prefix, seq) => {
          const format = `${parts.join('')}{SEQ:${String(digits)}}`;
          if (formatProblem(format, prefix) !== null) return true;
          if (String(seq).length > digits) return true;
          const n = renderInvoiceNumber(format, prefix, '2026-27', seq);
          return n.length <= 16 && /^[A-Za-z0-9/-]+$/.test(n);
        },
      ),
    );
  });
});

describe('metric definitions (SRS §7)', () => {
  it('defines every reported metric and never calls sales profit or cash', () => {
    expect(Object.keys(METRICS)).toEqual(
      expect.arrayContaining([
        'grossSales',
        'netSales',
        'cashReceived',
        'receivables',
        'grossMargin',
        'operatingProfit',
      ]),
    );
    expect(METRICS.operatingProfit.label).toMatch(/estimate/);
    expect(METRICS.grossSales.label).not.toMatch(/profit|cash/i);
    expect(METRICS.netSales.label).not.toMatch(/profit|cash/i);
  });
});

describe('branch coverage of edge paths', () => {
  it('refunds stop once covered', () => {
    expect(
      refundSources(
        [
          { id: 'a', unallocatedPaise: 300 },
          { id: 'b', unallocatedPaise: 300 },
        ],
        300,
      ),
    ).toEqual([{ paymentId: 'a', amountPaise: 300 }]);
  });
});
