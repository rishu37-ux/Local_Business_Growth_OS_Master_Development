// One business: application view while pending, setup wizard while setting up,
// overview when active (mode comes from the API's access gate).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { api, ApiError, type Me } from '../api.ts';
import { Alert, Button, errorText, Field, NativeSelect, Page } from '../ui.tsx';

interface BusinessView {
  business: { legal_name: string; display_name: string | null; status: string };
  access: { mode: string; roles: string[] };
}
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
      <Page title={application.data.legal_name}>
        <p className="mb-2">
          Application status: <strong>{application.data.status.replaceAll('_', ' ').toLowerCase()}</strong>
        </p>
        {last?.reason ? <p className="mb-2">Reason: {last.reason}</p> : null}
      </Page>
    );
  }
  if (view.error) {
    const code = view.error instanceof ApiError ? view.error.code : '';
    return (
      <Page title="Business">
        <Alert message={view.error.message} />
        {code === 'MFA_ENROLMENT_REQUIRED' ? (
          <Link className="text-blue-800 underline" to="/mfa">
            Set up two-step verification
          </Link>
        ) : null}
      </Page>
    );
  }
  const b = view.data.business;
  return (
    <Page title={b.display_name ?? b.legal_name}>
      <p className="mb-4">
        Status: <strong>{b.status.replaceAll('_', ' ').toLowerCase()}</strong> · Your role:{' '}
        {view.data.access.roles.join(', ') || 'none'}
      </p>
      <nav aria-label="Business" className="mb-4">
        <Link className="text-blue-800 underline" to={`/b/${businessId}/members`}>
          Staff and invitations
        </Link>
      </nav>
      {view.data.access.mode === 'SETUP' ? <SetupWizard businessId={businessId} me={me} /> : null}
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
      <h2 id="setup-heading" className="mb-2 text-xl font-semibold">
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
      <p className="mb-2 text-sm text-slate-700">
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
        <Link className="text-blue-800 underline" to="/mfa">
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
