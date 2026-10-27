// Application chrome: the top bar and, inside a business, the side navigation
// (a horizontal, scrollable bar on small screens). Menu entries appear only
// for screens the member may use; the API checks every permission again.
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router';
import { api, type Me } from './api.ts';
import { useBusiness } from './business.ts';
import { Badge, BrandMark, humanize, statusTone } from './ui.tsx';

type IconName = 'home' | 'box' | 'layers' | 'cart' | 'scan' | 'truck' | 'check' | 'users';

const ICON_PATHS: Readonly<Record<IconName, string>> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5V8Zm-9 5L3.5 8.3M12 13l8.5-4.7M12 13v8',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  cart: 'M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2M9 20.5a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1Zm9 0a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1Z',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3m-8 0H5a1 1 0 0 1-1-1v-3M7 12h10',
  truck:
    'M3 6h11v10H3V6Zm11 4h4l3 3v3h-7v-6ZM7 19.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z',
  check: 'M9 12.5 11 14.5 15.5 10M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z',
  users:
    'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm10 9v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.15a3.5 3.5 0 0 1 0 6.7',
};

export function Icon(props: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={props.className ?? 'h-5 w-5'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[props.name]} />
    </svg>
  );
}

/** Screens of a business: path, label, permission needed, icon. */
export const SCREENS: readonly (readonly [string, string, string, IconName])[] = [
  ['catalogue', 'Catalogue', 'catalogue.view', 'box'],
  ['stock', 'Stock', 'inventory.view', 'layers'],
  ['purchases', 'Purchases', 'purchases.view', 'cart'],
  ['scans', 'Scans', 'ocr.scan', 'scan'],
  ['suppliers', 'Suppliers', 'suppliers.view', 'truck'],
  ['approvals', 'Approvals', 'approvals.decide', 'check'],
  ['members', 'Staff and invitations', 'users.view', 'users'],
];

export function TopBar(props: { me: Me | null | undefined }) {
  const queryClient = useQueryClient();
  const signOut = async () => {
    await api('/api/auth/sign-out', { method: 'POST', body: {} });
    await queryClient.invalidateQueries();
  };
  const initials = (props.me?.name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75">
      <div className="mx-auto flex h-16 max-w-[90rem] items-center justify-between gap-3 px-4 sm:px-6">
        <Link to="/" className="flex min-w-0 items-center gap-2.5 rounded-lg">
          <BrandMark className="h-8 w-8 shrink-0" />
          <span className="truncate text-[0.95rem] font-semibold tracking-tight text-ink-900">
            Local Business Growth OS
          </span>
        </Link>
        {props.me ? (
          <nav aria-label="Account" className="flex shrink-0 items-center gap-1 sm:gap-2">
            {props.me.platformAdmin ? (
              <Link
                className="rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-100 hover:text-ink-900"
                to="/platform"
              >
                Review
              </Link>
            ) : null}
            <span
              className="hidden h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800 sm:inline-flex"
              aria-hidden="true"
            >
              {initials || '?'}
            </span>
            <button
              type="button"
              className="cursor-pointer rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-100 hover:text-ink-900"
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </nav>
        ) : null}
      </div>
    </header>
  );
}

function NavItem(props: { to: string; end?: boolean; icon: IconName; children: ReactNode }) {
  return (
    <li className="shrink-0">
      <NavLink
        to={props.to}
        end={props.end ?? false}
        className={({ isActive }) =>
          `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition ${
            isActive
              ? 'bg-brand-50 text-brand-800 ring-1 ring-brand-200'
              : 'text-ink-700 hover:bg-ink-100 hover:text-ink-900'
          }`
        }
      >
        <Icon name={props.icon} className="h-[1.15rem] w-[1.15rem] shrink-0" />
        {props.children}
      </NavLink>
    </li>
  );
}

/** Layout for /b/:businessId/*: business navigation beside the page. */
export function BusinessShell() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const view = business.data;
  // While the business is pending, unavailable or still loading there is nothing to navigate.
  if (!view || view.access.mode === 'APPLICATION' || view.access.mode === 'CLOSED') return <Outlet />;
  const b = view.business;
  const base = `/b/${businessId}`;
  const screens = SCREENS.filter(([, , permission]) => business.can(permission));
  return (
    <div className="business-shell mx-auto flex max-w-[90rem] flex-col lg:flex-row">
      <aside className="border-b border-ink-200 bg-white lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] lg:w-64 lg:shrink-0 lg:border-b-0 lg:bg-transparent">
        <div className="hidden border-b border-ink-100 px-5 py-5 lg:block">
          <p className="truncate text-sm font-semibold text-ink-900">{b.display_name ?? b.legal_name}</p>
          <div className="mt-2">
            <Badge tone={statusTone(b.status)}>{humanize(b.status)}</Badge>
          </div>
        </div>
        <nav aria-label="Business" className="px-3 py-2 lg:py-4">
          <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
            <NavItem to={base} end icon="home">
              Overview
            </NavItem>
            {screens.map(([path, label, , icon]) => (
              <NavItem key={path} to={`${base}/${path}`} icon={icon}>
                {label}
              </NavItem>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
