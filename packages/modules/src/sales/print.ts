// Printed documents (FR-PRN-1, FR-TAX-4, ADR-12, D-044). One HTML template
// per paper size, rendered only from the issued document and its party
// snapshot, so a reprint matches what was issued. Every value is escaped; the
// page has no scripts. The same HTML is printed by the browser and turned into
// a PDF by headless Chromium.
//
// FR-TAX-4: nothing here mentions e-invoicing, IRN/QR codes or digital
// signatures; such features stay off until an integration is configured.
import { amountInWords, stateLabel } from '@lbgos/domain';
import type { InvoiceDetail } from './invoices.ts';
import type { PaperSize } from './print-settings.ts';

interface Snapshot {
  seller?: {
    legalName?: string;
    displayName?: string | null;
    registrationType?: string;
    gstin?: string | null;
    stateCode?: string;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  buyer?: {
    name?: string;
    mobileE164?: string | null;
    gstin?: string | null;
    stateCode?: string | null;
    address?: string | null;
  } | null;
  terms?: string | null;
}

const esc = (v: string | number | null | undefined): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ₹1,23,456.78 (Indian digit grouping). */
export const money = (paise: number): string => `${paise < 0 ? '−' : ''}₹${inr.format(Math.abs(paise) / 100)}`;
const qty = (q: string) => q.replace(/\.?0+$/, '') || '0';
const pct = (p: string) => `${qty(p)}%`;
const date = (d: string) => {
  const [y, m, day] = d.split('-');
  return `${day ?? ''}-${m ?? ''}-${y ?? ''}`;
};

const TITLES: Readonly<Record<string, string>> = {
  TAX_INVOICE: 'Tax Invoice',
  BILL_OF_SUPPLY: 'Bill of Supply',
  CREDIT_NOTE: 'Credit Note',
  DEBIT_NOTE: 'Debit Note',
};

const METHODS: Readonly<Record<string, string>> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  ADVANCE: 'Advance',
  OTHER: 'Other',
};

const PAGE_CSS: Readonly<Record<PaperSize, string>> = {
  A4: '@page { size: A4; margin: 12mm; } body { font-size: 10pt; } .sheet { max-width: 186mm; }',
  A5: '@page { size: A5; margin: 8mm; } body { font-size: 8.5pt; } .sheet { max-width: 132mm; } .lines th, .lines td { padding: 3px 3px; font-size: 0.8em; } .head .seller .name { font-size: 1.2em; }',
  '80MM': '@page { size: 80mm auto; margin: 3mm; } body { font-size: 8.5pt; } .sheet { width: 74mm; }',
  '58MM': '@page { size: 58mm auto; margin: 2mm; } body { font-size: 7.5pt; } .sheet { width: 54mm; }',
};

const BASE_CSS = `
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #151a2d; font-family: 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif; line-height: 1.35; }
.sheet { margin: 0 auto; }
h1 { margin: 0; font-size: 1.5em; letter-spacing: 0.02em; text-transform: uppercase; color: #302b86; }
.muted { color: #47506c; }
.small { font-size: 0.85em; }
.right { text-align: right; }
.center { text-align: center; }
.bold { font-weight: 700; }
.nowrap { white-space: nowrap; }
.item { overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; font-weight: 600; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: center; padding: 10px 12px; margin-bottom: 16px; background: #eef2ff; border-bottom: 1px solid #c7d2fe; font-size: 13px; }
.toolbar a { color: #3b34a8; font-weight: 600; }
@media print { .toolbar { display: none; } }
@media screen { body { background: #f6f7fb; } .sheet { background: #fff; padding: 12mm; margin-bottom: 24px; box-shadow: 0 2px 10px rgba(21,26,45,.08); } }
`;

const WIDE_CSS = `
.head { display: flex; justify-content: space-between; gap: 16px; padding-bottom: 10px; border-bottom: 2px solid #302b86; }
.head .seller .name { font-size: 1.35em; font-weight: 700; }
.head .doc { text-align: right; }
.parties { display: flex; gap: 16px; margin: 12px 0; }
.parties > div { flex: 1; border: 1px solid #d9dde9; border-radius: 6px; padding: 8px 10px; }
.label { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em; color: #5f6987; font-weight: 600; margin-bottom: 2px; }
.lines th { background: #eceef5; border-bottom: 1px solid #b6bdd1; padding: 5px 6px; font-size: 0.85em; }
.lines td { border-bottom: 1px solid #eceef5; padding: 5px 6px; vertical-align: top; }
.summary { display: flex; gap: 16px; margin-top: 12px; align-items: flex-start; }
.summary > .left { flex: 1.3; }
.summary > .totals { flex: 1; }
.totals td { padding: 3px 6px; }
.totals .grand td { border-top: 2px solid #302b86; font-size: 1.15em; font-weight: 700; padding-top: 6px; }
.taxes th, .taxes td { border: 1px solid #d9dde9; padding: 3px 5px; font-size: 0.85em; }
.words { margin-top: 8px; padding: 6px 8px; background: #f6f7fb; border-radius: 4px; }
.foot { display: flex; justify-content: space-between; gap: 16px; margin-top: 18px; align-items: flex-end; }
.sign { min-width: 45mm; text-align: center; border-top: 1px solid #8a93ad; padding-top: 4px; }
`;

const NARROW_CSS = `
.sheet { padding: 0; }
@media screen { .sheet { padding: 4mm; } }
h1 { font-size: 1.15em; text-align: center; }
.rule { border-top: 1px dashed #5f6987; margin: 5px 0; }
.line td { padding: 1px 0; vertical-align: top; }
.totals td { padding: 1px 0; }
.totals .grand td { font-weight: 700; font-size: 1.15em; border-top: 1px solid #151a2d; padding-top: 3px; }
`;

interface Model {
  title: string;
  d: InvoiceDetail;
  s: Snapshot;
  taxed: boolean;
  igst: boolean;
  composition: boolean;
  balance: number;
}

function model(d: InvoiceDetail): Model {
  const s = (d.partySnapshot ?? {}) as Snapshot;
  return {
    title: TITLES[d.documentType] ?? d.documentType,
    d,
    s,
    taxed:
      d.documentType !== 'BILL_OF_SUPPLY' &&
      d.lines.some((l) => Number(l.taxRatePercent) > 0 || l.cgstPaise + l.sgstPaise + l.igstPaise > 0),
    igst: d.igstPaise > 0,
    composition: s.seller?.registrationType === 'COMPOSITION',
    balance: d.documentType === 'CREDIT_NOTE' ? 0 : d.totalPaise - d.allocatedPaise - d.creditedPaise,
  };
}

/** Tax by HSN and rate (the summary GST invoices carry). */
function taxSummary(d: InvoiceDetail) {
  const groups = new Map<
    string,
    { hsn: string; rate: string; taxable: number; cgst: number; sgst: number; igst: number; cess: number }
  >();
  for (const l of d.lines) {
    const key = `${l.hsnCode ?? '—'}|${l.taxRatePercent}`;
    const g = groups.get(key) ?? {
      hsn: l.hsnCode ?? '—',
      rate: l.taxRatePercent,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
    };
    g.taxable += l.taxablePaise;
    g.cgst += l.cgstPaise;
    g.sgst += l.sgstPaise;
    g.igst += l.igstPaise;
    g.cess += l.cessPaise;
    groups.set(key, g);
  }
  return [...groups.values()];
}

function partyLines(p: Snapshot['buyer'] | Snapshot['seller']): string {
  if (!p) return '';
  const lines: string[] = [];
  if (p.address) lines.push(esc(p.address).replace(/\n/g, '<br>'));
  if ('mobileE164' in p && p.mobileE164) lines.push(`Mobile: ${esc(p.mobileE164)}`);
  if ('phone' in p && p.phone) lines.push(`Phone: ${esc(p.phone)}`);
  if ('email' in p && p.email) lines.push(`Email: ${esc(p.email)}`);
  if (p.gstin) lines.push(`GSTIN: <span class="bold">${esc(p.gstin)}</span>`);
  if (p.stateCode) lines.push(`State: ${esc(stateLabel(p.stateCode))}`);
  return lines.map((l) => `<div>${l}</div>`).join('');
}

function totalsRows(m: Model, cls: string): string {
  const d = m.d;
  const rows: [string, number, string?][] = [];
  if (d.discountPaise > 0) {
    rows.push(['Value before discount', d.grossPaise]);
    rows.push(['Discount', -d.discountPaise]);
  }
  rows.push([m.taxed ? 'Taxable value' : 'Value', d.taxablePaise]);
  if (d.cgstPaise > 0) rows.push(['CGST', d.cgstPaise]);
  if (d.sgstPaise > 0) rows.push(['SGST', d.sgstPaise]);
  if (d.igstPaise > 0) rows.push(['IGST', d.igstPaise]);
  if (d.cessPaise > 0) rows.push(['Cess', d.cessPaise]);
  if (d.roundOffPaise !== 0) rows.push(['Round-off', d.roundOffPaise]);
  const body = rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="right">${money(v)}</td></tr>`).join('');
  return `<table class="${cls}">${body}<tr class="grand"><td>Total</td><td class="right">${money(d.totalPaise)}</td></tr></table>`;
}

function paymentsBlock(m: Model, narrow: boolean): string {
  const d = m.d;
  if (d.documentType === 'CREDIT_NOTE') return '';
  const rows = d.payments
    .map(
      (p) =>
        `<tr><td>${esc(METHODS[p.method] ?? p.method)}${p.reference ? ` <span class="muted small">(${esc(p.reference)})</span>` : ''}</td><td class="right">${money(p.allocatedPaise)}</td></tr>`,
    )
    .join('');
  const credited =
    d.creditedPaise > 0 ? `<tr><td>Credit notes</td><td class="right">${money(d.creditedPaise)}</td></tr>` : '';
  const balance = `<tr class="bold"><td>${m.balance > 0 ? 'Balance due' : 'Balance'}</td><td class="right">${money(Math.max(m.balance, 0))}</td></tr>`;
  const label = narrow ? '<div class="bold">Payments</div>' : '<div class="label">Payments received</div>';
  return `<div class="payments">${label}<table class="totals">${rows || '<tr><td class="muted">None</td><td></td></tr>'}${credited}${balance}</table></div>`;
}

function docMeta(m: Model): string {
  const d = m.d;
  const parts = [
    `<div><span class="muted">No.</span> <span class="bold">${esc(d.number)}</span></div>`,
    `<div><span class="muted">Date</span> ${esc(date(d.invoiceDate))}</div>`,
  ];
  if (d.originalInvoiceNumber)
    parts.push(`<div><span class="muted">Against invoice</span> ${esc(d.originalInvoiceNumber)}</div>`);
  if (m.taxed || d.documentType !== 'BILL_OF_SUPPLY')
    parts.push(`<div><span class="muted">Place of supply</span> ${esc(stateLabel(d.placeOfSupply))}</div>`);
  if (d.status === 'CANCELLED') parts.push('<div class="bold" style="color:#a4140c">CANCELLED</div>');
  return parts.join('');
}

function wide(m: Model): string {
  const { d, s } = m;
  const seller = s.seller ?? {};
  const name = seller.displayName ?? seller.legalName ?? '';
  const legal =
    seller.displayName && seller.legalName && seller.displayName !== seller.legalName
      ? `<div class="muted">${esc(seller.legalName)}</div>`
      : '';
  // The discount column appears only when some line has a discount (narrow papers need the room).
  const hasDiscount = d.lines.some((l) => l.discountPaise + l.invoiceDiscountPaise > 0);
  const head = [
    '<th>#</th><th>Item</th><th>HSN</th><th class="right">Qty</th><th class="right">Rate</th>',
    hasDiscount ? '<th class="right">Discount</th>' : '',
    m.taxed ? '<th class="right">Taxable value</th><th class="right">GST</th>' : '',
    '<th class="right">Amount</th>',
  ].join('');
  const rows = d.lines
    .map((l) => {
      const disc = l.discountPaise + l.invoiceDiscountPaise;
      return [
        `<tr><td>${String(l.lineNo)}</td><td class="item">${esc(l.description)}</td><td>${esc(l.hsnCode ?? '—')}</td>`,
        `<td class="right">${esc(qty(l.quantity))}</td><td class="right nowrap">${money(l.unitPricePaise)}</td>`,
        hasDiscount ? `<td class="right nowrap">${disc > 0 ? money(disc) : '—'}</td>` : '',
        m.taxed
          ? `<td class="right nowrap">${money(l.taxablePaise)}</td><td class="right">${esc(pct(l.taxRatePercent))}</td>`
          : '',
        `<td class="right nowrap">${money(l.totalPaise)}</td></tr>`,
      ].join('');
    })
    .join('');
  const taxes = m.taxed
    ? `<div class="label" style="margin-top:10px">Tax summary</div><table class="taxes"><tr><th>HSN</th><th class="right">Rate</th><th class="right">Taxable value</th>${
        m.igst ? '<th class="right">IGST</th>' : '<th class="right">CGST</th><th class="right">SGST</th>'
      }<th class="right">Cess</th></tr>${taxSummary(d)
        .map(
          (g) =>
            `<tr><td>${esc(g.hsn)}</td><td class="right">${esc(pct(g.rate))}</td><td class="right">${money(g.taxable)}</td>${
              m.igst
                ? `<td class="right">${money(g.igst)}</td>`
                : `<td class="right">${money(g.cgst)}</td><td class="right">${money(g.sgst)}</td>`
            }<td class="right">${money(g.cess)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const buyer = s.buyer
    ? `<div><div class="label">${d.documentType === 'CREDIT_NOTE' ? 'Issued to' : 'Bill to'}</div><div class="bold">${esc(s.buyer.name)}</div>${partyLines(s.buyer)}</div>`
    : `<div><div class="label">Bill to</div><div>Walk-in customer</div></div>`;
  return `<div class="sheet">
<div class="head">
  <div class="seller"><div class="name">${esc(name)}</div>${legal}${partyLines(seller)}</div>
  <div class="doc"><h1>${esc(m.title)}</h1>${m.composition ? '<div class="small">Composition taxable person, not eligible to collect tax on supplies</div>' : ''}${docMeta(m)}</div>
</div>
<div class="parties">${buyer}</div>
<table class="lines"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
<div class="summary">
  <div class="left">${taxes}<div class="words"><span class="label">Amount in words</span><div class="bold">${esc(amountInWords(d.totalPaise))}</div></div>${paymentsBlock(m, false)}</div>
  <div class="totals">${totalsRows(m, 'totals')}</div>
</div>
<div class="foot">
  <div class="small">${s.terms ? `<div class="label">Terms</div><div>${esc(s.terms).replace(/\n/g, '<br>')}</div>` : ''}</div>
  <div class="sign small">For ${esc(name)}<br><br><br>Authorised signatory</div>
</div>
</div>`;
}

function narrow(m: Model): string {
  const { d, s } = m;
  const seller = s.seller ?? {};
  const name = seller.displayName ?? seller.legalName ?? '';
  const items = d.lines
    .map(
      (l) =>
        `<tr class="line"><td colspan="2">${esc(l.description)}${l.hsnCode ? ` <span class="muted">HSN ${esc(l.hsnCode)}</span>` : ''}</td></tr>
<tr class="line"><td class="muted">${esc(qty(l.quantity))} × ${money(l.unitPricePaise)}${l.discountPaise + l.invoiceDiscountPaise > 0 ? ` − ${money(l.discountPaise + l.invoiceDiscountPaise)}` : ''}${m.taxed ? ` · GST ${esc(pct(l.taxRatePercent))}` : ''}</td><td class="right">${money(l.totalPaise)}</td></tr>`,
    )
    .join('');
  const taxes = m.taxed
    ? `<div class="rule"></div><table class="totals small">${taxSummary(d)
        .map(
          (g) =>
            `<tr><td>${esc(g.hsn)} @ ${esc(pct(g.rate))} on ${money(g.taxable)}</td><td class="right">${money(g.cgst + g.sgst + g.igst + g.cess)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const buyer = s.buyer
    ? `<div class="bold">${esc(s.buyer.name)}</div>${partyLines(s.buyer)}`
    : '<div>Walk-in customer</div>';
  return `<div class="sheet">
<div class="center"><div class="bold" style="font-size:1.2em">${esc(name)}</div>${partyLines(seller)}</div>
<div class="rule"></div>
<h1>${esc(m.title)}</h1>${m.composition ? '<div class="center small">Composition taxable person, not eligible to collect tax on supplies</div>' : ''}
<div class="small">${docMeta(m)}</div>
<div class="rule"></div>
<div class="small">${buyer}</div>
<div class="rule"></div>
<table>${items}</table>
<div class="rule"></div>
${totalsRows(m, 'totals')}
${taxes}
<div class="small" style="margin-top:4px">${esc(amountInWords(d.totalPaise))}</div>
<div class="rule"></div>
<div class="small">${paymentsBlock(m, true)}</div>
${s.terms ? `<div class="rule"></div><div class="small">${esc(s.terms).replace(/\n/g, '<br>')}</div>` : ''}
<div class="center small" style="margin-top:6px">Thank you</div>
</div>`;
}

export interface PrintOptions {
  readonly size: PaperSize;
  /** Links in the on-screen toolbar (not printed); omitted for PDFs. */
  readonly toolbar?: { readonly pdfHref: string; readonly sizeHref: (size: PaperSize) => string } | undefined;
}

export function renderDocumentHtml(d: InvoiceDetail, options: PrintOptions): string {
  const m = model(d);
  const isNarrow = options.size === '80MM' || options.size === '58MM';
  const css = `${BASE_CSS}${isNarrow ? NARROW_CSS : WIDE_CSS}${PAGE_CSS[options.size]}`;
  const sizes: [PaperSize, string][] = [
    ['A4', 'A4'],
    ['A5', 'A5'],
    ['80MM', '80 mm'],
    ['58MM', '58 mm'],
  ];
  const toolbar = options.toolbar
    ? `<nav class="toolbar" aria-label="Print options"><span>Print with your browser (Ctrl+P / Share → Print).</span><span>Paper: ${sizes
        .map(([s, label]) =>
          s === options.size
            ? `<strong>${label}</strong>`
            : `<a href="${esc(options.toolbar?.sizeHref(s))}">${label}</a>`,
        )
        .join(' · ')}</span><a href="${esc(options.toolbar.pdfHref)}">Download PDF</a></nav>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)} ${esc(d.number)}</title><style>${css}</style></head>
<body>${toolbar}<main>${isNarrow ? narrow(m) : wide(m)}</main></body></html>`;
}
