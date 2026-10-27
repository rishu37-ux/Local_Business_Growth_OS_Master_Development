// Pending approval requests (WORKFLOWS §11). The decider approves the exact
// payload shown: its hash is sent back and checked by the server.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../api.ts';
import { Alert, Button, errorText, Field, Page } from '../ui.tsx';

interface Request {
  id: string;
  actionType: string;
  payload: { kind?: string; quantity?: string; reason?: string; variantId?: string; unitId?: string };
  payloadSha256: string;
  status: string;
  requestedByName: string | null;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
}

const KIND: Readonly<Record<string, string>> = {
  QUANTITY: 'Change a stock count',
  DAMAGE: 'Write off damaged stock',
  UNIT_WRITE_OFF: 'Write off a unit',
  CORRECTION: 'Correct an earlier adjustment',
};

export function ApprovalsPage() {
  const { businessId = '' } = useParams();
  const queryClient = useQueryClient();
  const pending = useQuery({
    queryKey: ['approvals', businessId],
    queryFn: () => api<{ requests: Request[] }>(`/api/businesses/${businessId}/approvals?status=PENDING`),
  });
  const variants = useQuery({
    queryKey: ['stock', businessId, ''],
    queryFn: () =>
      api<{ stock: { variantId: string; productName: string; sku: string }[] }>(`/api/businesses/${businessId}/stock`),
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const variantName = (id?: string) => {
    const v = variants.data?.stock.find((s) => s.variantId === id);
    return v ? `${v.productName} (${v.sku})` : 'a product';
  };

  const decide = async (r: Request, approve: boolean) => {
    setMessage(null);
    try {
      const out = await api<{ request: { status: string; errorCode: string | null } }>(
        `/api/businesses/${businessId}/approvals/${r.id}/decide`,
        {
          method: 'POST',
          body: { approve, payloadSha256: r.payloadSha256, ...(notes[r.id] ? { note: notes[r.id] } : {}) },
        },
      );
      const s = out.request.status;
      setMessage(
        s === 'EXECUTION_FAILED'
          ? { text: `Approved, but it could not be carried out (${out.request.errorCode ?? 'error'}).`, tone: 'error' }
          : { text: s === 'REJECTED' ? 'Rejected.' : 'Approved and carried out.', tone: 'success' },
      );
      await queryClient.invalidateQueries({ queryKey: ['approvals', businessId] });
      await queryClient.invalidateQueries({ queryKey: ['stock', businessId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  const list = pending.data?.requests ?? [];
  return (
    <Page title="Approvals">
      <Alert message={pending.error ? errorText(pending.error) : null} />
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      {list.length === 0 ? <p>No requests are waiting.</p> : null}
      <ul>
        {list.map((r) => {
          const title = `${KIND[r.payload.kind ?? ''] ?? r.actionType}: ${variantName(r.payload.variantId)}${r.payload.quantity ? `, quantity ${r.payload.quantity}` : ''}`;
          return (
            <li key={r.id} className="mb-4 rounded border border-slate-300 bg-white p-3">
              <h2 className="mb-1 font-semibold">{title}</h2>
              <p className="mb-1">
                Requested by {r.requestedByName ?? 'a member'} · Reason: {r.reason ?? '—'}
              </p>
              <p className="mb-2 text-sm text-slate-700">Expires {new Date(r.expiresAt).toLocaleString('en-IN')}</p>
              <Field
                label={`Note for ${title} (needed to reject)`}
                name={`note-${r.id}`}
                value={notes[r.id] ?? ''}
                onChange={(v) => {
                  setNotes((n) => ({ ...n, [r.id]: v }));
                }}
                isRequired={false}
              />
              <div className="flex flex-wrap gap-3">
                <Button onPress={() => void decide(r, true)}>Approve</Button>
                <Button variant="secondary" onPress={() => void decide(r, false)}>
                  Reject
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Page>
  );
}
