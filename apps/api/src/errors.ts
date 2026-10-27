// Maps internal failures to safe HTTP responses (increment 3.4 AC5). Clients
// get a stable error code, a generic message and the request ID; database
// messages, constraint names, SQL and stack traces stay in the server log.

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

interface Mapped {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

// SQLSTATEs raised by our triggers (DATA_MODEL.md §4) and by PostgreSQL itself.
const DB_ERRORS: Readonly<Record<string, Mapped>> = {
  LB001: { status: 409, code: 'APPEND_ONLY', message: 'This record cannot be changed; record a reversal instead.' },
  LB002: { status: 409, code: 'INVALID_TRANSITION', message: 'This status change is not allowed.' },
  LB003: { status: 409, code: 'IMMUTABLE_DOCUMENT', message: 'This document can no longer be changed.' },
  LB004: { status: 422, code: 'TOTALS_MISMATCH', message: 'Document totals do not match its lines.' },
  LB005: { status: 422, code: 'ALLOCATION_OUT_OF_BOUNDS', message: 'The amount exceeds what can be allocated.' },
  LB006: { status: 409, code: 'DUPLICATE_APPLICATION', message: 'You already have an open application.' },
  LB007: { status: 409, code: 'INVALID_STATE', message: 'This action is not possible in the current status.' },
  LB008: { status: 403, code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
  LB009: { status: 409, code: 'ALREADY_PROVISIONED', message: 'This business has already been set up.' },
  LB012: { status: 409, code: 'TAX_RATE_OVERLAP', message: 'Another version of this tax rate covers these dates.' },
  LB013: {
    status: 409,
    code: 'TAX_RATE_IMMUTABLE',
    message: 'A tax-rate version cannot be changed; add a new version.',
  },
  LB014: {
    status: 409,
    code: 'SERIALIZED_LOCKED',
    message: 'Serial tracking cannot be changed after stock was recorded.',
  },
  LB015: { status: 409, code: 'INSUFFICIENT_STOCK', message: 'There is not enough stock for this change.' },
  LB016: { status: 409, code: 'NOT_DRAFT', message: 'Only a draft can be changed.' },
  '23505': { status: 409, code: 'CONFLICT', message: 'A record with these details already exists.' },
  '23503': { status: 422, code: 'INVALID_REFERENCE', message: 'A referenced record does not exist.' },
  '23514': { status: 422, code: 'CONSTRAINT_VIOLATION', message: 'The data violates a business rule.' },
  // Should never reach a client in normal operation: the API checks
  // permissions first. Reaching RLS means a bug or an attack, so it is logged
  // as a security event by the error handler.
  '42501': { status: 403, code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
};

export const INTERNAL: Mapped = { status: 500, code: 'INTERNAL', message: 'Something went wrong.' };

export function mapDatabaseError(err: unknown): Mapped | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code = err.code;
  return typeof code === 'string' ? DB_ERRORS[code] : undefined;
}

export function errorBody(mapped: Mapped, requestId: string): ApiErrorBody {
  return { error: { code: mapped.code, message: mapped.message, requestId } };
}
