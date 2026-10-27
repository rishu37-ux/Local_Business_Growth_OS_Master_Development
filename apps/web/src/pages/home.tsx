// "My businesses", the application form and notifications.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link } from 'react-router';
import { api, STATES, type Me } from '../api.ts';
import { Alert, Button, errorText, Field, NativeSelect, Page } from '../ui.tsx';

interface MyBusiness {
  businessId: string;
  legalName: string;
  displayName: string | null;
  status: string;
}

export function HomePage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const businesses = useQuery({
    queryKey: ['businesses'],
    queryFn: () => api<{ businesses: MyBusiness[] }>('/api/businesses'),
  });
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: { id: string; title: string; body: string }[] }>('/api/notifications'),
  });
  const [legalName, setLegalName] = useState('');
  const [stateCode, setStateCode] = useState(STATES[0]?.[0] ?? '');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);

  const apply = async () => {
    setMessage(null);
    try {
      await api('/api/applications', {
        method: 'POST',
        body: { legalName, category: 'MOBILE_ELECTRONICS', stateCode },
      });
      setMessage({ text: 'Application submitted. A platform admin will review it.', tone: 'success' });
      setLegalName('');
      await queryClient.invalidateQueries({ queryKey: ['businesses'] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  const mustEnrol = me.mfaRequired && !me.twoFactorEnabled;
  const list = businesses.data?.businesses ?? [];
  return (
    <Page title={`Welcome, ${me.name}`}>
      {mustEnrol ? (
        <div role="alert" className="mb-4 rounded border border-amber-700 bg-amber-50 p-3">
          Two-step verification is required for your account.{' '}
          <Link className="font-medium text-blue-800 underline" to="/mfa">
            Set it up now
          </Link>
        </div>
      ) : null}

      <section aria-labelledby="biz-heading" className="mb-6">
        <h2 id="biz-heading" className="mb-2 text-xl font-semibold">
          Your businesses
        </h2>
        {list.length === 0 ? <p>You are not part of any business yet.</p> : null}
        <ul className="flex flex-col gap-2">
          {list.map((b) => (
            <li key={b.businessId} className="rounded border border-slate-300 bg-white p-3">
              <Link className="font-medium text-blue-800 underline" to={`/b/${b.businessId}`}>
                {b.displayName ?? b.legalName}
              </Link>{' '}
              <span className="text-sm text-slate-700">({b.status.replaceAll('_', ' ').toLowerCase()})</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="apply-heading" className="mb-6">
        <h2 id="apply-heading" className="mb-2 text-xl font-semibold">
          Register a mobile or electronics shop
        </h2>
        <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          <Field label="Legal business name" name="legalName" value={legalName} onChange={setLegalName} />
          <NativeSelect label="State" name="stateCode" value={stateCode} onChange={setStateCode} options={STATES} />
          <Button type="submit">Submit application</Button>
        </Form>
      </section>

      <section aria-labelledby="notes-heading">
        <h2 id="notes-heading" className="mb-2 text-xl font-semibold">
          Notifications
        </h2>
        <ul className="flex flex-col gap-2">
          {(notifications.data?.notifications ?? []).map((n) => (
            <li key={n.id} className="rounded border border-slate-300 bg-white p-3">
              <p className="font-medium">{n.title}</p>
              <p>{n.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
