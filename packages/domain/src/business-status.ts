// Business lifecycle and access modes (WORKFLOWS.md §1, §3; D-009, D-010; BR-T1…T4).
// The transition table mirrors the lbg.businesses status trigger; a DB test
// checks the two agree for every pair of statuses.

export const BUSINESS_STATUSES = [
  'PENDING_APPROVAL',
  'CHANGES_REQUESTED',
  'APPROVED_SETUP_PENDING',
  'ACTIVE',
  'SUSPENDED',
  'REJECTED',
] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BUSINESS_TRANSITIONS: readonly (readonly [BusinessStatus, BusinessStatus])[] = [
  ['PENDING_APPROVAL', 'APPROVED_SETUP_PENDING'],
  ['PENDING_APPROVAL', 'CHANGES_REQUESTED'],
  ['PENDING_APPROVAL', 'REJECTED'],
  ['CHANGES_REQUESTED', 'PENDING_APPROVAL'],
  ['CHANGES_REQUESTED', 'REJECTED'],
  ['APPROVED_SETUP_PENDING', 'ACTIVE'],
  ['APPROVED_SETUP_PENDING', 'SUSPENDED'],
  ['ACTIVE', 'SUSPENDED'],
  ['SUSPENDED', 'ACTIVE'],
  ['SUSPENDED', 'APPROVED_SETUP_PENDING'],
];

export function canTransition(from: BusinessStatus, to: BusinessStatus): boolean {
  return BUSINESS_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** Platform-admin decisions and the transitions they make. */
export const PLATFORM_ACTIONS = {
  approve: { from: ['PENDING_APPROVAL'], to: 'APPROVED_SETUP_PENDING' },
  request_changes: { from: ['PENDING_APPROVAL'], to: 'CHANGES_REQUESTED' },
  reject: { from: ['PENDING_APPROVAL', 'CHANGES_REQUESTED'], to: 'REJECTED' },
  suspend: { from: ['ACTIVE', 'APPROVED_SETUP_PENDING'], to: 'SUSPENDED' },
} as const satisfies Record<string, { from: readonly BusinessStatus[]; to: BusinessStatus }>;
export type PlatformAction = keyof typeof PLATFORM_ACTIONS | 'reinstate';

/** BR-T3: decisions other than approval need a reason of at least 10 characters. */
export const MIN_REASON_LENGTH = 10;

/**
 * What a member can do in a business, given its status and subscription.
 * - NONE: no access to business data
 * - CLOSED: rejected application; the applicant may still read it (and the reason, BR-T3 AC2)
 * - APPLICATION: view/edit the application only
 * - SETUP: set up the shop; no selling, payments or marketing yet
 * - FULL: everything their roles allow
 * - READ_ONLY: view and export only (plus paying the subscription)
 */
export type AccessMode = 'NONE' | 'CLOSED' | 'APPLICATION' | 'SETUP' | 'FULL' | 'READ_ONLY';

export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  /** When the subscription became PAST_DUE (start of the grace period). */
  readonly pastDueSince?: Date;
  readonly graceDays: number;
}

export function accessMode(input: {
  readonly businessStatus: BusinessStatus;
  readonly isOwner: boolean;
  readonly subscription?: SubscriptionState;
  readonly now?: Date;
}): AccessMode {
  const base = baseMode(input.businessStatus, input.isOwner);
  if (base !== 'FULL' && base !== 'SETUP') return base;
  const sub = input.subscription;
  if (!sub) return base;
  if (sub.status === 'EXPIRED') return 'READ_ONLY';
  if (sub.status === 'PAST_DUE') {
    const now = input.now ?? new Date();
    const since = sub.pastDueSince ?? now;
    const graceEnds = since.getTime() + sub.graceDays * 24 * 60 * 60 * 1000;
    if (now.getTime() > graceEnds) return 'READ_ONLY';
  }
  return base;
}

function baseMode(status: BusinessStatus, isOwner: boolean): AccessMode {
  switch (status) {
    case 'PENDING_APPROVAL':
    case 'CHANGES_REQUESTED':
      return 'APPLICATION';
    case 'REJECTED':
      return 'CLOSED';
    case 'APPROVED_SETUP_PENDING':
      return 'SETUP';
    case 'ACTIVE':
      return 'FULL';
    case 'SUSPENDED':
      // D-009: staff cannot use a suspended business; the owner keeps read-only access.
      return isOwner ? 'READ_ONLY' : 'NONE';
  }
}

// Permissions blocked until the business is ACTIVE (WORKFLOWS.md §1: "no sales, messaging or campaigns").
const SETUP_BLOCKED_PREFIXES = ['pos.', 'payments.', 'sales.', 'invoices.', 'credit_notes.', 'refunds.'];
const SETUP_BLOCKED = new Set(['marketing.send', 'marketing.approve']);

const APPLICATION_PERMISSIONS = new Set(['application.view', 'application.edit']);

/** Whether `permission` may be used at all in `mode` (role grants are checked separately). */
export function permittedInMode(permission: string, mode: AccessMode): boolean {
  switch (mode) {
    case 'NONE':
      return false;
    case 'CLOSED':
      return permission === 'application.view';
    case 'APPLICATION':
      return APPLICATION_PERMISSIONS.has(permission);
    case 'SETUP':
      return !SETUP_BLOCKED.has(permission) && !SETUP_BLOCKED_PREFIXES.some((p) => permission.startsWith(p));
    case 'FULL':
      return true;
    case 'READ_ONLY':
      return (
        permission.endsWith('.view') ||
        permission.endsWith('.export') ||
        permission === 'subscription.manage' ||
        permission === 'application.view'
      );
  }
}

/** Permissions every member has implicitly in APPLICATION mode (no roles exist before approval). */
export function implicitPermissions(mode: AccessMode): readonly string[] {
  if (mode === 'APPLICATION') return [...APPLICATION_PERMISSIONS];
  if (mode === 'CLOSED') return ['application.view'];
  return [];
}
