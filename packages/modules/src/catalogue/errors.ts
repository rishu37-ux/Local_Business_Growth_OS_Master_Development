// Catalogue rule violations, mapped to HTTP by the API.

export type CatalogueErrorCode =
  'NOT_FOUND' | 'IN_USE' | 'DUPLICATE' | 'INVALID_REFERENCE' | 'COST_FORBIDDEN' | 'INVALID_INPUT';

export class CatalogueError extends Error {
  readonly code: CatalogueErrorCode;
  /** Request field the error is about, when there is one. */
  readonly field: string | undefined;

  constructor(code: CatalogueErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'CatalogueError';
    this.code = code;
    this.field = field;
  }
}

const pgCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
const pgConstraint = (err: unknown): string =>
  typeof err === 'object' && err !== null && 'constraint' in err && typeof err.constraint === 'string'
    ? err.constraint
    : '';

// Unique constraints/indexes → the request field they protect.
const UNIQUE_FIELDS: Readonly<Record<string, string>> = {
  product_variants_business_id_sku_key: 'sku',
  product_variants_barcode_uq: 'barcode',
  categories_business_id_name_key: 'name',
  brands_name_uq: 'name',
};

/** Turns PostgreSQL constraint errors into CatalogueErrors; rethrows anything else. */
export function translateDbError(err: unknown, onForeignKey: 'IN_USE' | 'INVALID_REFERENCE'): never {
  const code = pgCode(err);
  if (code === '23505') {
    const field = UNIQUE_FIELDS[pgConstraint(err)];
    throw new CatalogueError('DUPLICATE', field ? `${field} is already used in this business` : 'duplicate', field);
  }
  if (code === '23503') {
    if (onForeignKey === 'IN_USE') {
      throw new CatalogueError('IN_USE', 'This record has stock, purchases or sales; archive it instead.');
    }
    throw new CatalogueError('INVALID_REFERENCE', 'A referenced record does not exist.');
  }
  throw err;
}
