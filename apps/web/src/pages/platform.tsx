// Platform review queue (BR-T2, BR-T3).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { Alert, Button, errorText, Field, Page } from '../ui.tsx';

interface Application {
  businessId: string;
  legalName: string;
  status: string;
  stateCode: string | null;
  applicants: { email: string; displayName: string }[];
}

export function PlatformPage() {
  const queue = useQuery({
    queryKey: ['platform', 'applications'],
    queryFn: () => api<{ applications: Application[] }>('/api/platform/applications'),
  });
  return (
    <Page title="Applications to review">
      <Alert message={queue.error ? errorText(queue.error) : null} />
      {(queue.data?.applications ?? []).length === 0 ? <p>No applications waiting.</p> : null}
      <ul className="flex flex-col gap-4">
        {(queue.data?.applications ?? []).map((a) => (
          <ApplicationCard key={a.businessId} application={a} />
        ))}
      </ul>
    </Page>
  );
}

function ApplicationCard({ application: a }: { application: Application }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string) => {
    setError(null);
    try {
      await api(`/api/platform/businesses/${a.businessId}/${path}`, { method: 'POST', body: reason ? { reason } : {} });
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <li className="rounded border border-slate-300 bg-white p-3">
      <h2 className="text-lg font-semibold">{a.legalName}</h2>
      <p className="mb-2 text-sm">
        {a.status.replaceAll('_', ' ').toLowerCase()} · state {a.stateCode ?? '—'} ·{' '}
        {a.applicants.map((p) => p.email).join(', ')}
      </p>
      <Alert message={error} />
      <Field
        label="Reason (required to reject or request changes)"
        name={`reason-${a.businessId}`}
        value={reason}
        onChange={setReason}
        isRequired={false}
      />
      <div className="flex flex-wrap gap-2">
        <Button onPress={() => void act('approve')}>Approve</Button>
        <Button variant="secondary" onPress={() => void act('request-changes')}>
          Request changes
        </Button>
        <Button variant="danger" onPress={() => void act('reject')}>
          Reject
        </Button>
      </div>
    </li>
  );
}
