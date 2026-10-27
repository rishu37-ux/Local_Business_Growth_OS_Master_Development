// Permission catalogue and default roles (docs/ROLES_PERMISSIONS.md, FR-RBAC-1).

export const BUSINESS_PERMISSIONS = [
  'application.view',
  'application.edit',
  'business.settings.view',
  'business.settings.manage',
  'tax.settings.manage',
  'users.view',
  'users.manage',
  'roles.manage',
  'audit.view',
  'subscription.manage',
  'catalogue.view',
  'catalogue.manage',
  'catalogue.cost.view',
  'inventory.view',
  'inventory.receive',
  'inventory.adjust.request',
  'inventory.adjust.approve',
  'inventory.transfer',
  'returns.inspect',
  'suppliers.view',
  'suppliers.manage',
  'purchases.view',
  'purchases.create',
  'purchases.post',
  'ocr.scan',
  'pos.sell',
  'pos.discount',
  'pos.price_override',
  'sales.return.create',
  'refunds.approve',
  'invoices.cancel',
  'credit_notes.create',
  'payments.record',
  'customers.view',
  'customers.manage',
  'customers.export',
  'customer_ledger.view',
  'expenses.manage',
  'reports.sales.view',
  'reports.financial.view',
  'reports.export',
  'marketing.draft',
  'marketing.approve',
  'marketing.send',
  'integrations.view',
  'integrations.manage',
  'agents.use',
  'approvals.decide',
  'support.grant',
] as const;

export const PLATFORM_PERMISSIONS = [
  'platform.applications.review',
  'platform.businesses.manage',
  'platform.plans.manage',
  'platform.integrations.manage',
  'platform.usage.view',
  'platform.audit.view',
  'platform.admins.manage',
] as const;

export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[number];
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

const businessSet: ReadonlySet<string> = new Set(BUSINESS_PERMISSIONS);
const platformSet: ReadonlySet<string> = new Set(PLATFORM_PERMISSIONS);

export const isBusinessPermission = (key: string): key is BusinessPermission => businessSet.has(key);
export const isPlatformPermission = (key: string): key is PlatformPermission => platformSet.has(key);

/** Limits attached to a grant, e.g. the discount ceiling for pos.discount. */
export interface PermissionLimits {
  readonly maxPercent?: number;
  readonly maxPaise?: number;
}

export interface RoleTemplate {
  readonly name: string;
  readonly isSystem: boolean;
  readonly permissions: readonly { readonly key: BusinessPermission; readonly limits?: PermissionLimits }[];
}

/** Owner holds every business permission; its discount limit is unlimited (no limits object). */
const ALL: RoleTemplate['permissions'] = BUSINESS_PERMISSIONS.map((key) => ({ key }));

const grant = (keys: readonly BusinessPermission[]) => keys.map((key) => ({ key }));

/**
 * Default role templates created for every approved business
 * (ROLES_PERMISSIONS.md §4). Discount limits are initial suggestions that
 * owners can change.
 */
export const DEFAULT_ROLES: readonly RoleTemplate[] = [
  { name: 'Owner', isSystem: true, permissions: ALL },
  {
    name: 'Manager',
    isSystem: false,
    permissions: [
      ...grant([
        'application.view',
        'business.settings.view',
        'users.view',
        'audit.view',
        'catalogue.view',
        'catalogue.manage',
        'catalogue.cost.view',
        'inventory.view',
        'inventory.receive',
        'inventory.adjust.request',
        'inventory.adjust.approve',
        'returns.inspect',
        'suppliers.view',
        'suppliers.manage',
        'purchases.view',
        'purchases.create',
        'purchases.post',
        'ocr.scan',
        'pos.sell',
        'pos.price_override',
        'sales.return.create',
        'refunds.approve',
        'invoices.cancel',
        'credit_notes.create',
        'payments.record',
        'customers.view',
        'customers.manage',
        'customer_ledger.view',
        'reports.sales.view',
        'reports.financial.view',
        'reports.export',
        'marketing.draft',
        'integrations.view',
        'agents.use',
        'approvals.decide',
      ]),
      { key: 'pos.discount', limits: { maxPercent: 10, maxPaise: 500_000 } },
    ],
  },
  {
    name: 'Billing',
    isSystem: false,
    permissions: [
      ...grant([
        'catalogue.view',
        'inventory.view',
        'pos.sell',
        'payments.record',
        'sales.return.create',
        'customers.view',
        'customers.manage',
        'customer_ledger.view',
        'agents.use',
      ]),
      { key: 'pos.discount', limits: { maxPercent: 2, maxPaise: 50_000 } },
    ],
  },
  {
    name: 'Inventory',
    isSystem: false,
    permissions: grant([
      'catalogue.view',
      'catalogue.manage',
      'inventory.view',
      'inventory.receive',
      'inventory.adjust.request',
      'returns.inspect',
      'suppliers.view',
      'suppliers.manage',
      'purchases.view',
      'purchases.create',
      'ocr.scan',
      'agents.use',
    ]),
  },
  {
    name: 'Accountant',
    isSystem: false,
    permissions: grant([
      'business.settings.view',
      'users.view',
      'audit.view',
      'catalogue.view',
      'catalogue.cost.view',
      'inventory.view',
      'suppliers.view',
      'purchases.view',
      'customers.view',
      'customer_ledger.view',
      'reports.sales.view',
      'reports.financial.view',
      'reports.export',
      'agents.use',
    ]),
  },
];

export const OWNER_ROLE_NAME = 'Owner';

/** A permission granted by one or more roles; `limits` undefined means unlimited. */
export interface EffectiveGrant {
  readonly limits: PermissionLimits | undefined;
}

/**
 * Combines grants from all of a member's roles. When several roles grant the
 * same permission, the most permissive limits win: an unlimited grant beats
 * any limit, otherwise each limit takes its highest value.
 */
export function effectivePermissions(
  grants: readonly { readonly key: string; readonly limits?: PermissionLimits | null | undefined }[],
): ReadonlyMap<string, EffectiveGrant> {
  const out = new Map<string, EffectiveGrant>();
  for (const g of grants) {
    const limits = g.limits ?? undefined;
    const existing = out.get(g.key);
    if (!existing) {
      out.set(g.key, { limits });
      continue;
    }
    if (existing.limits === undefined || limits === undefined) {
      out.set(g.key, { limits: undefined });
      continue;
    }
    out.set(g.key, { limits: mergeLimits(existing.limits, limits) });
  }
  return out;
}

function mergeLimits(a: PermissionLimits, b: PermissionLimits): PermissionLimits | undefined {
  const pick = (x: number | undefined, y: number | undefined) =>
    x === undefined || y === undefined ? undefined : Math.max(x, y);
  const maxPercent = pick(a.maxPercent, b.maxPercent);
  const maxPaise = pick(a.maxPaise, b.maxPaise);
  if (maxPercent === undefined && maxPaise === undefined) return undefined;
  return {
    ...(maxPercent === undefined ? {} : { maxPercent }),
    ...(maxPaise === undefined ? {} : { maxPaise }),
  };
}
