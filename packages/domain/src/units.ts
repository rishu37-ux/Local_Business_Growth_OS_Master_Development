// Serialized unit status machine (WORKFLOWS.md §4, FR-INV-3 AC6).

export const UNIT_STATUSES = [
  'IN_STOCK',
  'RESERVED',
  'SOLD',
  'PENDING_INSPECTION',
  'IN_REPAIR',
  'DAMAGED',
  'RETURNED_TO_SUPPLIER',
  'WRITTEN_OFF',
  'REVERSED',
] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

/** Stock bucket a unit in each status is counted in (null: no longer in stock). */
export const UNIT_BUCKET: Readonly<Record<UnitStatus, 'AVAILABLE' | 'INSPECTION' | 'DAMAGED' | 'REPAIR' | null>> = {
  IN_STOCK: 'AVAILABLE',
  RESERVED: 'AVAILABLE',
  SOLD: null,
  PENDING_INSPECTION: 'INSPECTION',
  IN_REPAIR: 'REPAIR',
  DAMAGED: 'DAMAGED',
  RETURNED_TO_SUPPLIER: null,
  WRITTEN_OFF: null,
  REVERSED: null,
};

export const UNIT_TRANSITIONS: readonly (readonly [UnitStatus, UnitStatus])[] = [
  ['IN_STOCK', 'RESERVED'],
  ['RESERVED', 'IN_STOCK'],
  ['IN_STOCK', 'SOLD'],
  ['RESERVED', 'SOLD'],
  ['SOLD', 'PENDING_INSPECTION'],
  ['SOLD', 'IN_STOCK'],
  ['PENDING_INSPECTION', 'IN_STOCK'],
  ['PENDING_INSPECTION', 'DAMAGED'],
  ['PENDING_INSPECTION', 'IN_REPAIR'],
  ['IN_REPAIR', 'PENDING_INSPECTION'],
  ['PENDING_INSPECTION', 'RETURNED_TO_SUPPLIER'],
  ['DAMAGED', 'RETURNED_TO_SUPPLIER'],
  ['IN_STOCK', 'RETURNED_TO_SUPPLIER'],
  ['IN_STOCK', 'WRITTEN_OFF'],
  ['DAMAGED', 'WRITTEN_OFF'],
  // A purchase reversal removes units that never really entered stock (D-033).
  ['IN_STOCK', 'REVERSED'],
];

export function canUnitTransition(from: UnitStatus, to: UnitStatus): boolean {
  return UNIT_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** Only IN_STOCK units can be sold (WORKFLOWS §4). */
export const isSellable = (status: UnitStatus): boolean => status === 'IN_STOCK';
