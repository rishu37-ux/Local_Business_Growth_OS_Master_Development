// Report exports (FR-RPT-4, D-045): CSV, XLSX and an HTML document that the
// API renders to PDF with the same renderer as invoices. A report is first
// turned into an ExportTable, so every format shows the same rows.
//
// CSV cells that a spreadsheet would run as a formula (=, +, -, @, tab, CR at
// the start of a text value) are prefixed with an apostrophe. Numbers are
// written as numbers. XLSX uses inline strings only (no formulas at all).
import { crc32, deflateRawSync } from 'node:zlib';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export interface ExportColumn {
  readonly key: string;
  readonly label: string;
  /** money: paise, shown as rupees with 2 decimals; qty: decimal text; int: count. */
  readonly kind: 'text' | 'money' | 'qty' | 'int';
}

export type ExportCell = string | number | null;

export interface ExportTable {
  readonly title: string;
  /** e.g. "1 Oct 2026 – 31 Oct 2026 · Asha Mobiles". */
  readonly subtitle: string;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly Readonly<Record<string, ExportCell>>[];
  readonly totals?: Readonly<Record<string, ExportCell>> | undefined;
  readonly notes?: readonly string[] | undefined;
  readonly definitions?: readonly { readonly label: string; readonly definition: string }[] | undefined;
}

const rupees = (paise: number) => (paise / 100).toFixed(2);

function cellText(col: ExportColumn, v: ExportCell): string {
  if (v === null) return '';
  if (col.kind === 'money' && typeof v === 'number') return rupees(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const BOM = String.fromCharCode(0xfeff);
const FORMULA_START = /^[=+\-@\t\r]/;

function csvField(col: ExportColumn, v: ExportCell): string {
  let text = cellText(col, v);
  if (col.kind === 'text' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(t: ExportTable): string {
  const head = t.columns.map((c) => csvField({ ...c, kind: 'text' }, c.kind === 'money' ? `${c.label} (₹)` : c.label));
  const lines = [head.join(',')];
  for (const r of t.rows) lines.push(t.columns.map((c) => csvField(c, r[c.key] ?? null)).join(','));
  if (t.totals) lines.push(t.columns.map((c) => csvField(c, t.totals?.[c.key] ?? null)).join(','));
  // A byte-order mark so spreadsheet programs read the file as UTF-8 (₹, names).
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// XLSX (Office Open XML in a ZIP container)
// ---------------------------------------------------------------------------

const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 does not allow.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A minimal ZIP writer (deflate, UTF-8 names), enough for an XLSX package. */
function zip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, deflated);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(f.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + deflated.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}

export function toXlsx(t: ExportTable): Buffer {
  // Style 0 default, 1 bold (headers, totals), 2 money "#,##0.00", 3 bold money.
  const cell = (ref: string, col: ExportColumn | null, v: ExportCell, bold: boolean) => {
    if (v === null || v === '') return '';
    if (col && (col.kind === 'money' || col.kind === 'int') && typeof v === 'number') {
      const value = col.kind === 'money' ? v / 100 : v;
      const s = col.kind === 'money' ? (bold ? 3 : 2) : bold ? 1 : 0;
      return `<c r="${ref}" s="${String(s)}"><v>${String(value)}</v></c>`;
    }
    if (col?.kind === 'qty' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      return `<c r="${ref}"${bold ? ' s="1"' : ''}><v>${String(Number(v))}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
  };
  const rows: string[] = [];
  let r = 1;
  rows.push(`<row r="${String(r)}">${cell(`A${String(r)}`, null, t.title, true)}</row>`);
  r++;
  rows.push(`<row r="${String(r)}">${cell(`A${String(r)}`, null, t.subtitle, false)}</row>`);
  r += 2;
  rows.push(
    `<row r="${String(r)}">${t.columns
      .map((c, i) => cell(`${colName(i)}${String(r)}`, null, c.kind === 'money' ? `${c.label} (₹)` : c.label, true))
      .join('')}</row>`,
  );
  for (const row of t.rows) {
    r++;
    rows.push(
      `<row r="${String(r)}">${t.columns.map((c, i) => cell(`${colName(i)}${String(r)}`, c, row[c.key] ?? null, false)).join('')}</row>`,
    );
  }
  if (t.totals) {
    r++;
    const totals = t.totals;
    rows.push(
      `<row r="${String(r)}">${t.columns.map((c, i) => cell(`${colName(i)}${String(r)}`, c, totals[c.key] ?? null, true)).join('')}</row>`,
    );
  }
  r++; // a blank row before the notes
  for (const note of [...(t.notes ?? []), ...(t.definitions ?? []).map((d) => `${d.label}: ${d.definition}`)]) {
    r++;
    rows.push(`<row r="${String(r)}">${cell(`A${String(r)}`, null, note, false)}</row>`);
  }
  const cols = t.columns
    .map(
      (c, i) =>
        `<col min="${String(i + 1)}" max="${String(i + 1)}" width="${c.kind === 'text' ? '32' : '16'}" customWidth="1"/>`,
    )
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>`;
  const sheetName = xml(t.title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31));
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: styles },
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })));
}

// ---------------------------------------------------------------------------
// HTML for PDF
// ---------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function htmlCell(col: ExportColumn, v: ExportCell): string {
  if (v === null) return '';
  if (col.kind === 'money' && typeof v === 'number') return `${v < 0 ? '−' : ''}₹${inr.format(Math.abs(v) / 100)}`;
  return esc(String(v));
}

export function toReportHtml(t: ExportTable): string {
  const num = (c: ExportColumn) => (c.kind === 'text' ? '' : ' class="num"');
  const head = t.columns.map((c) => `<th${num(c)}>${esc(c.label)}</th>`).join('');
  const body = t.rows
    .map((r) => `<tr>${t.columns.map((c) => `<td${num(c)}>${htmlCell(c, r[c.key] ?? null)}</td>`).join('')}</tr>`)
    .join('');
  const totals = t.totals
    ? `<tr class="total">${t.columns.map((c) => `<td${num(c)}>${htmlCell(c, t.totals?.[c.key] ?? null)}</td>`).join('')}</tr>`
    : '';
  const notes = (t.notes ?? []).map((n) => `<p class="note">${esc(n)}</p>`).join('');
  const defs = (t.definitions ?? []).map((d) => `<dt>${esc(d.label)}</dt><dd>${esc(d.definition)}</dd>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(t.title)}</title><style>
@page { size: A4; margin: 12mm; }
body { font-family: 'Segoe UI', system-ui, -apple-system, Arial, 'Noto Sans', sans-serif; font-size: 9.5pt; color: #151a2d; }
h1 { font-size: 16pt; margin: 0; color: #302b86; } .sub { color: #47506c; margin: 2px 0 12px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; background: #eceef5; font-size: 8.5pt; padding: 5px 6px; border-bottom: 1px solid #b6bdd1; }
td { padding: 4px 6px; border-bottom: 1px solid #eceef5; } .num { text-align: right; white-space: nowrap; }
tr.total td { font-weight: 700; border-top: 2px solid #302b86; }
.note { color: #47506c; margin: 8px 0 0; } dl { margin-top: 12px; font-size: 8.5pt; color: #47506c; } dt { font-weight: 600; color: #151a2d; } dd { margin: 0 0 4px; }
</style></head><body><main><h1>${esc(t.title)}</h1><p class="sub">${esc(t.subtitle)}</p>
<table><thead><tr>${head}</tr></thead><tbody>${body}${totals}</tbody></table>${notes}${defs ? `<dl>${defs}</dl>` : ''}</main></body></html>`;
}

export function exportReport(
  t: ExportTable,
  format: Exclude<ExportFormat, 'pdf'>,
): { body: Buffer; contentType: string } {
  return format === 'csv'
    ? { body: Buffer.from(toCsv(t), 'utf8'), contentType: 'text/csv; charset=utf-8' }
    : { body: toXlsx(t), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}
