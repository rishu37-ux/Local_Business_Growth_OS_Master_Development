import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { fetchMe, type Me } from './api.ts';
import { MfaPage, SignInPage, SignUpPage } from './pages/auth.tsx';
import { ApprovalsPage } from './pages/approvals.tsx';
import { BusinessPage } from './pages/business.tsx';
import { CataloguePage, ProductPage, TaxRatesPage } from './pages/catalogue.tsx';
import { HomePage } from './pages/home.tsx';
import { InvitePage } from './pages/invite.tsx';
import { MembersPage } from './pages/members.tsx';
import { PlatformPage } from './pages/platform.tsx';
import { PurchaseEditorPage, PurchasesPage } from './pages/purchases.tsx';
import { ReportsPage } from './pages/reports.tsx';
import { PosPage } from './pages/pos.tsx';
import { InvoiceDetailPage, InvoicesPage } from './pages/invoices.tsx';
import { CustomerPage, CustomersPage } from './pages/customers.tsx';
import { ExpensesPage } from './pages/expenses.tsx';
import { CampaignsPage } from './pages/campaigns.tsx';
import { IntegrationsPage } from './pages/integrations.tsx';
import { OffersPage } from './pages/offers.tsx';
import { StudioPage } from './pages/studio.tsx';
import { AssistantsPage } from './pages/assistants.tsx';
import { AccountPage } from './pages/account.tsx';
import { BrandingPage } from './pages/branding.tsx';
import { OnlineSellingPage } from './pages/online.tsx';
import { UsagePage } from './pages/usage.tsx';
import { RemindersPage } from './pages/reminders.tsx';
import { ScanReviewPage, ScansPage } from './pages/scans.tsx';
import { StockPage } from './pages/stock.tsx';
import { SuppliersPage } from './pages/suppliers.tsx';
import { BusinessShell, TopBar } from './shell.tsx';
import './styles.css';

function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: fetchMe });
}

function Layout() {
  const me = useMe();
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#content"
        className="sr-only z-50 rounded-lg bg-white px-3 py-2 shadow focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <TopBar me={me.data} />
      <div id="content" className="flex-1">
        <Outlet />
      </div>
      <footer className="border-t border-ink-200 bg-white">
        <div className="mx-auto flex max-w-[90rem] flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-ink-500 sm:px-6">
          <span>Local Business Growth OS</span>
          <span>Records are kept per shop; amounts are in Indian rupees.</span>
        </div>
      </footer>
    </div>
  );
}

/** Renders children with the signed-in user, or sends the visitor to sign in. */
function Authed({ children }: { children: (me: Me) => ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <p className="p-6 text-sm text-ink-600">Loading…</p>;
  if (!me.data)
    return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children(me.data)}</>;
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/sign-up', element: <SignUpPage /> },
      { path: '/', element: <Authed>{(me) => <HomePage me={me} />}</Authed> },
      { path: '/mfa', element: <Authed>{() => <MfaPage />}</Authed> },
      {
        path: '/b/:businessId',
        element: <BusinessShell />,
        children: [
          { index: true, element: <Authed>{(me) => <BusinessPage me={me} />}</Authed> },
          { path: 'members', element: <Authed>{() => <MembersPage />}</Authed> },
          { path: 'catalogue', element: <Authed>{() => <CataloguePage />}</Authed> },
          { path: 'catalogue/:productId', element: <Authed>{() => <ProductPage />}</Authed> },
          { path: 'tax-rates', element: <Authed>{() => <TaxRatesPage />}</Authed> },
          { path: 'suppliers', element: <Authed>{() => <SuppliersPage />}</Authed> },
          { path: 'purchases', element: <Authed>{() => <PurchasesPage />}</Authed> },
          { path: 'purchases/:purchaseId', element: <Authed>{() => <PurchaseEditorPage />}</Authed> },
          { path: 'stock', element: <Authed>{() => <StockPage />}</Authed> },
          { path: 'scans', element: <Authed>{() => <ScansPage />}</Authed> },
          { path: 'scans/:scanId', element: <Authed>{() => <ScanReviewPage />}</Authed> },
          { path: 'approvals', element: <Authed>{() => <ApprovalsPage />}</Authed> },
          { path: 'reports', element: <Authed>{() => <ReportsPage />}</Authed> },
          { path: 'pos', element: <Authed>{() => <PosPage />}</Authed> },
          { path: 'invoices', element: <Authed>{() => <InvoicesPage />}</Authed> },
          { path: 'invoices/:invoiceId', element: <Authed>{() => <InvoiceDetailPage />}</Authed> },
          { path: 'customers', element: <Authed>{() => <CustomersPage />}</Authed> },
          { path: 'customers/:customerId', element: <Authed>{() => <CustomerPage />}</Authed> },
          { path: 'reminders', element: <Authed>{() => <RemindersPage />}</Authed> },
          { path: 'expenses', element: <Authed>{() => <ExpensesPage />}</Authed> },
          { path: 'offers', element: <Authed>{() => <OffersPage />}</Authed> },
          { path: 'studio', element: <Authed>{() => <StudioPage />}</Authed> },
          { path: 'campaigns', element: <Authed>{() => <CampaignsPage />}</Authed> },
          { path: 'integrations', element: <Authed>{() => <IntegrationsPage />}</Authed> },
          { path: 'assistants', element: <Authed>{() => <AssistantsPage />}</Authed> },
          { path: 'usage', element: <Authed>{() => <UsagePage />}</Authed> },
          { path: 'account', element: <Authed>{() => <AccountPage />}</Authed> },
          { path: 'branding', element: <Authed>{() => <BrandingPage />}</Authed> },
          { path: 'online', element: <Authed>{() => <OnlineSellingPage />}</Authed> },
        ],
      },
      { path: '/invite', element: <Authed>{() => <InvitePage />}</Authed> },
      { path: '/platform', element: <Authed>{() => <PlatformPage />}</Authed> },
    ],
  },
]);

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
