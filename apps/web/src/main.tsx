import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { api, fetchMe, type Me } from './api.ts';
import { MfaPage, SignInPage, SignUpPage } from './pages/auth.tsx';
import { BusinessPage } from './pages/business.tsx';
import { HomePage } from './pages/home.tsx';
import { InvitePage } from './pages/invite.tsx';
import { MembersPage } from './pages/members.tsx';
import { PlatformPage } from './pages/platform.tsx';
import './styles.css';

function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: fetchMe });
}

function Layout() {
  const me = useMe();
  const queryClient = useQueryClient();
  const signOut = async () => {
    await api('/api/auth/sign-out', { method: 'POST', body: {} });
    await queryClient.invalidateQueries();
  };
  return (
    <>
      <a href="#content" className="sr-only focus:not-sr-only">
        Skip to content
      </a>
      <header className="border-b border-slate-300 bg-white">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link to="/" className="text-lg font-semibold">
            Local Business Growth OS
          </Link>
          {me.data ? (
            <nav aria-label="Account" className="flex items-center gap-3">
              {me.data.platformAdmin ? (
                <Link className="text-blue-800 underline" to="/platform">
                  Review
                </Link>
              ) : null}
              <button type="button" className="text-blue-800 underline" onClick={() => void signOut()}>
                Sign out
              </button>
            </nav>
          ) : null}
        </div>
      </header>
      <div id="content">
        <Outlet />
      </div>
    </>
  );
}

/** Renders children with the signed-in user, or sends the visitor to sign in. */
function Authed({ children }: { children: (me: Me) => ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <p className="p-4">Loading…</p>;
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
      { path: '/b/:businessId', element: <Authed>{(me) => <BusinessPage me={me} />}</Authed> },
      { path: '/b/:businessId/members', element: <Authed>{() => <MembersPage />}</Authed> },
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
