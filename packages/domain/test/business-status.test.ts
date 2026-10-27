import { describe, expect, it } from 'vitest';
import {
  accessMode,
  BUSINESS_STATUSES,
  canTransition,
  implicitPermissions,
  PLATFORM_ACTIONS,
  permittedInMode,
} from '../src/index.ts';

const day = 24 * 60 * 60 * 1000;

describe('transitions (WORKFLOWS.md §1)', () => {
  it('REJECTED is terminal and nothing returns to PENDING_APPROVAL except a resubmission', () => {
    for (const to of BUSINESS_STATUSES) expect(canTransition('REJECTED', to)).toBe(false);
    const intoPending = BUSINESS_STATUSES.filter((from) => canTransition(from, 'PENDING_APPROVAL'));
    expect(intoPending).toEqual(['CHANGES_REQUESTED']);
  });

  it('every platform action is a valid transition', () => {
    for (const action of Object.values(PLATFORM_ACTIONS)) {
      for (const from of action.from) expect(canTransition(from, action.to)).toBe(true);
    }
  });
});

describe('accessMode (D-009, D-010)', () => {
  it.each([
    ['PENDING_APPROVAL', 'APPLICATION'],
    ['CHANGES_REQUESTED', 'APPLICATION'],
    ['REJECTED', 'CLOSED'],
    ['APPROVED_SETUP_PENDING', 'SETUP'],
    ['ACTIVE', 'FULL'],
  ] as const)('%s → %s', (status, mode) => {
    expect(accessMode({ businessStatus: status, isOwner: true })).toBe(mode);
  });

  it('suspended: owner read-only, staff none', () => {
    expect(accessMode({ businessStatus: 'SUSPENDED', isOwner: true })).toBe('READ_ONLY');
    expect(accessMode({ businessStatus: 'SUSPENDED', isOwner: false })).toBe('NONE');
  });

  it('expired subscription is read-only; past due is read-only only after the grace period', () => {
    const now = new Date('2026-10-27T00:00:00Z');
    const base = { businessStatus: 'ACTIVE', isOwner: false, now } as const;
    expect(accessMode({ ...base, subscription: { status: 'EXPIRED', graceDays: 7 } })).toBe('READ_ONLY');
    const pastDue = (days: number) =>
      accessMode({
        ...base,
        subscription: { status: 'PAST_DUE', graceDays: 7, pastDueSince: new Date(now.getTime() - days * day) },
      });
    expect(pastDue(6)).toBe('FULL');
    expect(pastDue(8)).toBe('READ_ONLY');
    expect(accessMode({ ...base, subscription: { status: 'TRIALING', graceDays: 7 } })).toBe('FULL');
  });

  it('subscription state never widens access (rejected stays CLOSED)', () => {
    expect(
      accessMode({ businessStatus: 'REJECTED', isOwner: true, subscription: { status: 'ACTIVE', graceDays: 7 } }),
    ).toBe('CLOSED');
  });
});

describe('permittedInMode', () => {
  it('APPLICATION allows only application permissions, granted implicitly', () => {
    expect(implicitPermissions('APPLICATION')).toEqual(['application.view', 'application.edit']);
    expect(permittedInMode('application.edit', 'APPLICATION')).toBe(true);
    expect(permittedInMode('catalogue.view', 'APPLICATION')).toBe(false);
    expect(implicitPermissions('FULL')).toEqual([]);
  });

  it('SETUP blocks selling, payments, refunds and outgoing marketing', () => {
    for (const k of [
      'pos.sell',
      'payments.record',
      'refunds.approve',
      'invoices.cancel',
      'marketing.send',
      'sales.return.create',
    ]) {
      expect(permittedInMode(k, 'SETUP')).toBe(false);
    }
    for (const k of ['catalogue.manage', 'business.settings.manage', 'users.manage', 'tax.settings.manage']) {
      expect(permittedInMode(k, 'SETUP')).toBe(true);
    }
  });

  it('READ_ONLY allows views, exports and paying the subscription only', () => {
    expect(permittedInMode('catalogue.view', 'READ_ONLY')).toBe(true);
    expect(permittedInMode('customers.export', 'READ_ONLY')).toBe(true);
    expect(permittedInMode('subscription.manage', 'READ_ONLY')).toBe(true);
    expect(permittedInMode('catalogue.manage', 'READ_ONLY')).toBe(false);
    expect(permittedInMode('pos.sell', 'READ_ONLY')).toBe(false);
  });

  it('NONE allows nothing; CLOSED allows only reading the application', () => {
    expect(permittedInMode('catalogue.view', 'NONE')).toBe(false);
    expect(permittedInMode('application.view', 'NONE')).toBe(false);
    expect(implicitPermissions('CLOSED')).toEqual(['application.view']);
    expect(permittedInMode('application.view', 'CLOSED')).toBe(true);
    expect(permittedInMode('application.edit', 'CLOSED')).toBe(false);
  });
});
