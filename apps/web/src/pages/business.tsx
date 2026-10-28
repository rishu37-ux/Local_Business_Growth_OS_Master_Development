// One business: application view while pending, setup wizard while setting up,
// overview when active (mode comes from the API's access gate).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { api, ApiError, type Me } from '../api.ts';
import { Alert, Badge, Button, errorText, Field, humanize, NativeSelect, Page, statusTone } from '../ui.tsx';

interface BusinessView {
  business: { legal_name: string; display_name: string | null; status: string };
  access: { mode: string; roles: string[]; permissions: string[] };
}

// Quick tasks on the overview (navigation itself is the side menu). Shown only
// with the permission; the API checks again.
const TASKS: readonly (readonly [string, string, string, string])[] = [
  ['pos', 'Start a sale', 'Scan an IMEI or barcode, take payment and print the invoice.', 'pos.sell'],
  ['catalogue', 'Add a product', 'Models, variants, prices and tax rates.', 'catalogue.manage'],
  ['purchases/new', 'Record a purchase', 'Enter a supplier bill and scan IMEIs into stock.', 'purchases.create'],
  ['scans', 'Read a bill or label', 'Upload a photo; review what was read before saving.', 'ocr.scan'],
  ['stock', 'Check stock levels', 'Available, in inspection, damaged and reorder suggestions.', 'inventory.view'],
  ['approvals', 'Review requests', 'Adjustments and discounts waiting for a decision.', 'approvals.decide'],
  [
    'reports',
    'See how the shop is doing',
    'Sales, cash received, tax summary and what customers owe.',
    'reports.sales.view',
  ],
  ['members', 'Invite your team', 'Give staff the role they need, nothing more.', 'users.manage'],
];
interface Application {
  legal_name: string;
  status: string;
  history: { toStatus: string; reason: string | null }[];
}
interface Setup {
  completedSteps: string[];
  remainingRequired: string[];
}

export function BusinessPage({ me }: { me: Me }) {
  const { businessId = '' } = useParams();
  const view = useQuery({
    queryKey: ['business', businessId],
    queryFn: () => api<BusinessView>(`/api/businesses/${businessId}`),
    retry: false,
  });
  const unavailable = view.error instanceof ApiError && view.error.code === 'BUSINESS_NOT_AVAILABLE';
  const application = useQuery({
    queryKey: ['application', businessId],
    queryFn: () => api<Application>(`/api/businesses/${businessId}/application`),
    enabled: unavailable,
    retry: false,
  });

  if (view.isPending) return <Page title="Loading">…</Page>;
  if (unavailable && application.data) {
    const last = application.data.history.at(-1);
    return (
      <Page
        eyebrow="Application"
        title={application.data.legal_name}
        description={
          <span className="inline-flex items-center gap-2">
            Application status:{' '}
            <Badge tone={statusTone(application.data.status)}>{humanize(application.data.status)}</Badge>
          </span>
        }
      >
        <section>
          <p className="text-sm text-ink-700">
            A platform administrator reviews new shops before they can go live. You will get a notification when the
            status changes.
          </p>
          {last?.reason ? <p className="mt-3 text-sm">Reason given: {last.reason}</p> : null}
        </section>
      </Page>
    );
  }
  if (view.error) {
    const code = view.error instanceof ApiError ? view.error.code : '';
    return (
      <Page title="Business">
        <Alert message={view.error.message} />
        {code === 'MFA_ENROLMENT_REQUIRED' ? (
          <Link className="link" to="/mfa">
            Set up two-step verification
          </Link>
        ) : null}
      </Page>
    );
  }
  const b = view.data.business;
  const permissions = new Set(view.data.access.permissions);
  const tasks = TASKS.filter(([, , , permission]) => permissions.has(permission));
  const roles = view.data.access.roles.join(', ') || 'No role';
  return (
    <Page
      eyebrow="Overview"
      title={b.display_name ?? b.legal_name}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2">
            Status: <Badge tone={statusTone(b.status)}>{humanize(b.status)}</Badge>
          </span>
          <span aria-hidden="true">·</span>
          <span>Your role: {roles}</span>
        </span>
      }
    >
      {view.data.access.mode === 'SETUP' ? <SetupWizard businessId={businessId} me={me} /> : null}
      {tasks.length > 0 ? (
        <section aria-labelledby="tasks-heading">
          <h2 id="tasks-heading" className="section-title">
            Get things done
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {tasks.map(([path, label, hint]) => (
              <li key={path}>
                <Link
                  to={`/b/${businessId}/${path}`}
                  className="group flex h-full flex-col rounded-xl border border-ink-200 bg-ink-50/60 p-4 transition hover:border-brand-300 hover:bg-white hover:shadow-[var(--shadow-raised)]"
                >
                  <span className="flex items-center justify-between gap-2 font-semibold text-ink-900">
                    {label}
                    <span aria-hidden="true" className="text-brand-600 transition group-hover:translate-x-0.5">
                      →
                    </span>
                  </span>
                  <span className="mt-1 text-sm text-ink-600">{hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="access-heading">
        <h2 id="access-heading" className="section-title">
          Your access
        </h2>
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-ink-500">Business</dt>
            <dd className="mt-0.5 font-medium">{b.legal_name}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Roles</dt>
            <dd className="mt-0.5 font-medium">{roles}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Permissions</dt>
            <dd className="mt-0.5 font-medium">{String(view.data.access.permissions.length)} granted</dd>
          </div>
        </dl>
      </section>
    </Page>
  );
}

function SetupWizard({ businessId, me }: { businessId: string; me: Me }) {
  const queryClient = useQueryClient();
  const setup = useQuery({
    queryKey: ['setup', businessId],
    queryFn: () => api<Setup>(`/api/businesses/${businessId}/setup`),
  });
  const [displayName, setDisplayName] = useState('');
  const [registrationType, setRegistrationType] = useState('UNREGISTERED');
  const [gstin, setGstin] = useState('');
  const [prefix, setPrefix] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await fn();
      setMessage({ text: ok, tone: 'success' });
      await queryClient.invalidateQueries();
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };
  const done = new Set(setup.data?.completedSteps ?? []);
  const remaining = setup.data?.remainingRequired ?? [];

  return (
    <section aria-labelledby="setup-heading">
      <h2 id="setup-heading" className="section-title">
        Set up your shop
      </h2>
      <p className="mb-3">Required before going live: business details, tax, two-step verification.</p>
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />

      <h3 className="mt-4 mb-2 font-semibold">1. Business details {done.has('details') ? '✓' : ''}</h3>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              api(`/api/businesses/${businessId}/setup/details`, {
                method: 'PUT',
                body: { displayName, timezone: 'Asia/Kolkata', fyStartMonth: 4 },
              }),
            'Details saved.',
          );
        }}
      >
        <Field label="Shop name shown to customers" name="displayName" value={displayName} onChange={setDisplayName} />
        <Button type="submit">Save details</Button>
      </Form>

      <h3 className="mt-6 mb-2 font-semibold">2. Tax {done.has('tax') ? '✓' : ''}</h3>
      <p className="mb-2 text-sm text-ink-600">
        GST settings must be confirmed with your tax adviser. The GSTIN format is checked here, not its registration.
      </p>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              api(`/api/businesses/${businessId}/setup/tax`, {
                method: 'PUT',
                body: {
                  registrationType,
                  invoicePrefix: prefix,
                  ...(registrationType === 'UNREGISTERED' ? {} : { gstin }),
                },
              }),
            'Tax settings saved.',
          );
        }}
      >
        <NativeSelect
          label="GST registration"
          name="registrationType"
          value={registrationType}
          onChange={setRegistrationType}
          options={[
            ['UNREGISTERED', 'Not registered'],
            ['REGULAR', 'Regular'],
            ['COMPOSITION', 'Composition'],
          ]}
        />
        {registrationType === 'UNREGISTERED' ? null : (
          <Field label="GSTIN" name="gstin" value={gstin} onChange={setGstin} />
        )}
        <Field
          label="Invoice number prefix (up to 6 characters)"
          name="prefix"
          value={prefix}
          onChange={setPrefix}
          isRequired={false}
        />
        <Button type="submit">Save tax settings</Button>
      </Form>

      <h3 className="mt-6 mb-2 font-semibold">3. Two-step verification {me.twoFactorEnabled ? '✓' : ''}</h3>
      {me.twoFactorEnabled ? (
        <p>Enabled.</p>
      ) : (
        <Link className="link" to="/mfa">
          Set it up
        </Link>
      )}

      <div className="mt-6">
        <Button
          isDisabled={remaining.length > 0}
          onPress={() => {
            void run(
              () => api(`/api/businesses/${businessId}/activate`, { method: 'POST', body: {} }),
              'Your shop is live.',
            );
          }}
        >
          Go live
        </Button>
        {remaining.length > 0 ? <p className="mt-2 text-sm">Still needed: {remaining.join(', ')}</p> : null}
      </div>
    </section>
  );
}
