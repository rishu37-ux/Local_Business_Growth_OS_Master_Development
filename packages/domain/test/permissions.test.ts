import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BUSINESS_PERMISSIONS,
  DEFAULT_ROLES,
  effectivePermissions,
  isBusinessPermission,
  isPlatformPermission,
  OWNER_ROLE_NAME,
  PLATFORM_PERMISSIONS,
} from '../src/index.ts';

describe('permission catalogue', () => {
  it('has unique, well-formed keys matching the DB check (^[a-z_]+(\\.[a-z_]+)+$)', () => {
    const all = [...BUSINESS_PERMISSIONS, ...PLATFORM_PERMISSIONS];
    expect(new Set(all).size).toBe(all.length);
    for (const key of all) expect(key).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });

  it('keeps business and platform permissions disjoint', () => {
    for (const k of BUSINESS_PERMISSIONS) expect(isPlatformPermission(k)).toBe(false);
    for (const k of PLATFORM_PERMISSIONS) expect(isBusinessPermission(k)).toBe(false);
    expect(isBusinessPermission('catalogue.view')).toBe(true);
    expect(isBusinessPermission('catalogue.delete_everything')).toBe(false);
  });
});

describe('default roles (ROLES_PERMISSIONS.md §4)', () => {
  const role = (name: string) => DEFAULT_ROLES.find((r) => r.name === name);
  const keys = (name: string) => new Set(role(name)?.permissions.map((p) => p.key));

  it('Owner is the only system role and holds every business permission without limits', () => {
    expect(DEFAULT_ROLES.filter((r) => r.isSystem).map((r) => r.name)).toEqual([OWNER_ROLE_NAME]);
    expect(keys('Owner')).toEqual(new Set(BUSINESS_PERMISSIONS));
    expect(role('Owner')?.permissions.every((p) => p.limits === undefined)).toBe(true);
  });

  it('only the Owner manages roles, users, tax, integrations, subscription and support access', () => {
    for (const k of [
      'roles.manage',
      'users.manage',
      'tax.settings.manage',
      'integrations.manage',
      'subscription.manage',
      'support.grant',
    ] as const) {
      const holders = DEFAULT_ROLES.filter((r) => r.permissions.some((p) => p.key === k)).map((r) => r.name);
      expect(holders).toEqual([OWNER_ROLE_NAME]);
    }
  });

  it('Billing cannot see cost prices, approve refunds or cancel invoices, and has a 2% / ₹500 discount limit', () => {
    const billing = keys('Billing');
    for (const k of ['catalogue.cost.view', 'refunds.approve', 'invoices.cancel', 'reports.financial.view']) {
      expect(billing.has(k as never)).toBe(false);
    }
    expect(role('Billing')?.permissions.find((p) => p.key === 'pos.discount')?.limits).toEqual({
      maxPercent: 2,
      maxPaise: 50_000,
    });
  });

  it('Accountant is view/export only', () => {
    for (const k of keys('Accountant'))
      expect(k.endsWith('.view') || k.endsWith('.export') || k === 'agents.use').toBe(true);
  });

  it('every template references only catalogue permissions', () => {
    for (const r of DEFAULT_ROLES) for (const p of r.permissions) expect(isBusinessPermission(p.key)).toBe(true);
  });
});

describe('effectivePermissions', () => {
  it('merges roles: unlimited beats limited; otherwise the higher limit wins', () => {
    const merged = effectivePermissions([
      { key: 'pos.discount', limits: { maxPercent: 2, maxPaise: 50_000 } },
      { key: 'pos.discount', limits: { maxPercent: 10, maxPaise: 20_000 } },
      { key: 'catalogue.view' },
      { key: 'refunds.approve', limits: { maxPaise: 1 } },
      { key: 'refunds.approve', limits: null },
    ]);
    expect(merged.get('pos.discount')?.limits).toEqual({ maxPercent: 10, maxPaise: 50_000 });
    expect(merged.get('catalogue.view')?.limits).toBeUndefined();
    expect(merged.get('refunds.approve')?.limits).toBeUndefined();
    expect(merged.has('users.manage')).toBe(false);
  });

  it('is order-independent and never grants a key that no role grants', () => {
    const grantArb = fc.record({
      key: fc.constantFrom('pos.discount', 'catalogue.view', 'users.view'),
      limits: fc.option(fc.record({ maxPercent: fc.integer({ min: 0, max: 100 }) }), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(grantArb, { maxLength: 8 }), (grants) => {
        const a = effectivePermissions(grants);
        const b = effectivePermissions([...grants].reverse());
        expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
        for (const k of a.keys()) expect(grants.some((g) => g.key === k)).toBe(true);
      }),
    );
  });
});
