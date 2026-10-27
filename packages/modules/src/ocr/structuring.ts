// Optional structuring step (FR-OCR-5). A structurer (e.g. a language model
// adapter, none configured yet — Q4) may propose values the deterministic
// parser missed. Its output is accepted only if it matches a strict schema;
// otherwise it is discarded and the job is marked for manual entry. Accepted
// values are used only if they appear verbatim in the OCR text (so nothing is
// invented), only for fields the parser left empty, and always need confirmation.
import type { ExtractedField, ProductLabelExtraction, SupplierInvoiceExtraction } from '@lbgos/domain';
import { z } from 'zod';

const text = (max: number) => z.string().min(1).max(max).nullable().optional();

const productLabelSchema = z.strictObject({
  brand: text(40),
  modelName: text(60),
  modelNumber: text(40),
  ram: text(20),
  storage: text(20),
  colour: text(30),
  serialNumber: text(30),
});

const supplierInvoiceSchema = z.strictObject({
  supplierName: text(120),
  invoiceNo: text(40),
  invoiceDate: text(10),
});

type Extraction = ProductLabelExtraction | SupplierInvoiceExtraction;

export interface StructuringOutcome {
  readonly extraction: Extraction;
  /** The structurer's output was discarded (FR-OCR-5 AC2). */
  readonly manualEntry: boolean;
}

export function applyStructured(
  extraction: Extraction,
  structured: unknown,
  ocrLines: readonly string[] | null,
): StructuringOutcome {
  if (structured === undefined) return { extraction, manualEntry: false };
  const schema = extraction.scanType === 'PRODUCT_LABEL' ? productLabelSchema : supplierInvoiceSchema;
  const parsed = schema.safeParse(structured);
  if (!parsed.success) return { extraction, manualEntry: true };
  const proposals = parsed.data as Record<string, string | null | undefined>;
  const lines = ocrLines ?? [];
  const fields = extraction.fields.map((f): ExtractedField => {
    const proposed = proposals[f.key];
    if (f.value !== null || !proposed) return f;
    const source = lines.find((l) => l.includes(proposed));
    if (!source) return f; // not in the document: dropped, never invented
    return { ...f, value: proposed, confidence: null, level: 'unknown', source, needsConfirmation: true };
  });
  return { extraction: { ...extraction, fields }, manualEntry: false };
}
