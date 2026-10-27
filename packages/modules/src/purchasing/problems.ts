// Deterministic checks on a purchase before it may be posted (FR-INV-3,
// FR-INV-8, FR-OCR-3). Pure: callers pass in what the database knows.
import { isValidImei } from '@lbgos/domain';

export type ProblemCode =
  | 'NO_LINES'
  | 'QTY_NOT_WHOLE'
  | 'UNIT_COUNT_MISMATCH'
  | 'UNITS_ON_NON_SERIALIZED'
  | 'IMEI_INVALID'
  | 'IMEI_SAME'
  | 'IMEI_DUPLICATE_IN_PURCHASE'
  | 'IMEI_EXISTS'
  | 'IMEI_IN_OTHER_DRAFT'
  | 'SERIAL_DUPLICATE_IN_PURCHASE'
  | 'SERIAL_EXISTS'
  | 'TAX_RATE_NOT_EFFECTIVE'
  | 'NO_TAX_RATE'
  | 'SUPPLIER_TOTAL_MISMATCH'
  | 'DUPLICATE_SUPPLIER_INVOICE'
  | 'VARIANT_ARCHIVED';

export interface PurchaseProblem {
  readonly code: ProblemCode;
  /** BLOCKING problems prevent posting; WARNINGs are shown for review. */
  readonly severity: 'BLOCKING' | 'WARNING';
  readonly message: string;
  readonly lineNo?: number;
  /** 1-based position of the unit within its line. */
  readonly position?: number;
  readonly field?: 'imei1' | 'imei2' | 'serialNumber' | 'quantity' | 'taxRateId' | 'supplierInvoiceNo';
  /** Existing unit with this IMEI (only for callers with inventory.view). */
  readonly existingUnitId?: string;
  readonly differencePaise?: number;
}

export interface CheckedUnit {
  readonly position: number;
  readonly imei1: string | null;
  readonly imei2: string | null;
  readonly serialNumber: string | null;
}

export interface CheckedLine {
  readonly lineNo: number;
  readonly variantId: string;
  readonly serialized: boolean;
  readonly archived: boolean;
  readonly qtyMilli: number;
  /** A rate was requested but no version of it is in force on the invoice date. */
  readonly rateNotEffective: boolean;
  readonly hasRate: boolean;
  readonly units: readonly CheckedUnit[];
}

export interface PurchaseFacts {
  readonly lines: readonly CheckedLine[];
  /** IMEI → existing unit ID (any status) in this business. */
  readonly existingImeis: ReadonlyMap<string, string>;
  /** IMEIs on other draft purchases of this business. */
  readonly otherDraftImeis: ReadonlySet<string>;
  /** `${variantId}|${serial}` of existing units. */
  readonly existingSerials: ReadonlySet<string>;
  readonly computedTotalPaise: number;
  readonly supplierTotalPaise: number | null;
  readonly duplicateSupplierInvoice: boolean;
  readonly canViewInventory: boolean;
}

export function checkPurchase(f: PurchaseFacts): PurchaseProblem[] {
  const out: PurchaseProblem[] = [];
  if (f.lines.length === 0) out.push({ code: 'NO_LINES', severity: 'BLOCKING', message: 'Add at least one line.' });
  const seenImeis = new Set<string>();
  const seenSerials = new Set<string>();
  for (const line of f.lines) {
    const at = { lineNo: line.lineNo };
    if (line.archived) {
      out.push({ ...at, code: 'VARIANT_ARCHIVED', severity: 'WARNING', message: 'This variant is archived.' });
    }
    if (line.rateNotEffective) {
      out.push({
        ...at,
        code: 'TAX_RATE_NOT_EFFECTIVE',
        severity: 'BLOCKING',
        field: 'taxRateId',
        message: 'No version of this tax rate is in force on the invoice date.',
      });
    } else if (!line.hasRate) {
      out.push({
        ...at,
        code: 'NO_TAX_RATE',
        severity: 'WARNING',
        field: 'taxRateId',
        message: 'No tax rate: no tax is computed for this line.',
      });
    }
    if (!line.serialized) {
      if (line.units.length > 0) {
        out.push({
          ...at,
          code: 'UNITS_ON_NON_SERIALIZED',
          severity: 'BLOCKING',
          message: 'IMEIs/serials can only be entered for serialized products.',
        });
      }
      continue;
    }
    if (line.qtyMilli % 1000 !== 0) {
      out.push({
        ...at,
        code: 'QTY_NOT_WHOLE',
        severity: 'BLOCKING',
        field: 'quantity',
        message: 'Serialized items are counted in whole units.',
      });
    } else if (line.units.length !== line.qtyMilli / 1000) {
      out.push({
        ...at,
        code: 'UNIT_COUNT_MISMATCH',
        severity: 'BLOCKING',
        field: 'quantity',
        message: `Quantity is ${String(line.qtyMilli / 1000)} but ${String(line.units.length)} IMEI/serial entries were given.`,
      });
    }
    for (const u of line.units) {
      const where = { ...at, position: u.position };
      for (const field of ['imei1', 'imei2'] as const) {
        const imei = u[field];
        if (imei === null) continue;
        // FR-INV-3 AC2 / FR-OCR-3 AC1: flagged, never corrected.
        if (!isValidImei(imei)) {
          out.push({
            ...where,
            field,
            code: 'IMEI_INVALID',
            severity: 'BLOCKING',
            message: 'Not a valid IMEI (15 digits with a correct check digit).',
          });
          continue;
        }
        if (seenImeis.has(imei)) {
          out.push({
            ...where,
            field,
            code: 'IMEI_DUPLICATE_IN_PURCHASE',
            severity: 'BLOCKING',
            message: 'This IMEI appears more than once in this purchase.',
          });
        }
        seenImeis.add(imei);
        const existing = f.existingImeis.get(imei);
        if (existing !== undefined) {
          out.push({
            ...where,
            field,
            code: 'IMEI_EXISTS',
            severity: 'BLOCKING',
            message: 'A unit with this IMEI already exists in this business.',
            ...(f.canViewInventory ? { existingUnitId: existing } : {}),
          });
        } else if (f.otherDraftImeis.has(imei)) {
          out.push({
            ...where,
            field,
            code: 'IMEI_IN_OTHER_DRAFT',
            severity: 'WARNING',
            message: 'This IMEI is also on another draft purchase.',
          });
        }
      }
      if (u.imei1 !== null && u.imei1 === u.imei2) {
        out.push({
          ...where,
          field: 'imei2',
          code: 'IMEI_SAME',
          severity: 'BLOCKING',
          message: 'IMEI 1 and IMEI 2 must differ.',
        });
      }
      if (u.serialNumber !== null) {
        const key = `${line.variantId}|${u.serialNumber}`;
        if (seenSerials.has(key)) {
          out.push({
            ...where,
            field: 'serialNumber',
            code: 'SERIAL_DUPLICATE_IN_PURCHASE',
            severity: 'BLOCKING',
            message: 'This serial number appears more than once for this variant.',
          });
        } else if (f.existingSerials.has(key)) {
          out.push({
            ...where,
            field: 'serialNumber',
            code: 'SERIAL_EXISTS',
            severity: 'BLOCKING',
            message: 'A unit of this variant with this serial number already exists.',
          });
        }
        seenSerials.add(key);
      }
    }
  }
  if (f.supplierTotalPaise !== null && f.supplierTotalPaise !== f.computedTotalPaise) {
    out.push({
      code: 'SUPPLIER_TOTAL_MISMATCH',
      severity: 'WARNING',
      message: 'The computed total differs from the total printed on the supplier invoice.',
      differencePaise: f.computedTotalPaise - f.supplierTotalPaise,
    });
  }
  if (f.duplicateSupplierInvoice) {
    out.push({
      code: 'DUPLICATE_SUPPLIER_INVOICE',
      severity: 'BLOCKING',
      field: 'supplierInvoiceNo',
      message:
        'A posted purchase from this supplier already has this invoice number. Posting needs an override reason.',
    });
  }
  return out;
}
