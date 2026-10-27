// Metric definitions (SRS §7, FR-RPT-2, FR-LED-3). Shown next to every figure
// in reports and dashboards. Sales are never labelled profit or cash.

export const METRICS = {
  grossSales: {
    label: 'Gross sales',
    definition:
      'Total of invoice line values after discounts, including tax, for issued invoices (not cancelled) in the period.',
  },
  returns: { label: 'Returns', definition: 'Total value of credit notes issued in the period.' },
  netSales: { label: 'Net sales', definition: 'Gross sales minus returns.' },
  taxableValue: { label: 'Taxable value', definition: 'Net sales excluding tax.' },
  taxCollected: { label: 'Tax collected', definition: 'CGST + SGST + IGST (+ cess) on net sales.' },
  cashReceived: {
    label: 'Cash received',
    definition: 'All payments received in the period, by method, whichever invoice period they relate to.',
  },
  receivables: { label: 'Receivables', definition: 'Total of positive customer balances at the end of the period.' },
  customerAdvances: {
    label: 'Customer advances',
    definition: 'Total of negative customer balances (amounts held for customers) at the end of the period.',
  },
  cogs: {
    label: 'Cost of goods sold',
    definition:
      'Cost of units and quantities sold (serialized: actual unit cost; others: weighted average cost at the time of sale), minus the cost of returns restocked.',
  },
  grossMargin: {
    label: 'Gross margin',
    definition: 'Taxable value minus cost of goods sold (and as a percentage of taxable value).',
  },
  expenses: {
    label: 'Expenses',
    definition: 'Total recorded expenses in the period (only when expenses are enabled).',
  },
  operatingProfit: {
    label: 'Operating profit (estimate)',
    definition: 'Gross margin minus expenses. An estimate: it excludes anything not recorded in the system.',
  },
  stockValuation: {
    label: 'Stock valuation',
    definition: 'On-hand quantity × cost (serialized: actual unit cost; others: current weighted average cost).',
  },
} as const satisfies Record<string, { label: string; definition: string }>;

export type MetricKey = keyof typeof METRICS;
