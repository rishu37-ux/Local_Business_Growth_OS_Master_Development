// Staff list and invitations (FR-ONB-2 "users" step).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api } from '../api.ts';
import { Alert, Button, errorText, Field, NativeSelect, Page } from '../ui.tsx';

export function MembersPage() {
  const { businessId = '' } = useParams();
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ['members', businessId],
    queryFn: () =>
      api<{ members: { membershipId: string; email: string; displayName: string; status: string; roles: string[] }[] }>(
        `/api/businesses/${businessId}/members`,
      ),
  });
  const roles = useQuery({
    queryKey: ['roles', businessId],
    queryFn: () => api<{ roles: { id: string; name: string }[] }>(`/api/businesses/${businessId}/roles`),
  });
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const roleOptions = (roles.data?.roles ?? []).filter((r) => r.name !== 'Owner').map((r) => [r.id, r.name] as const);
  const selectedRole = roleId || roleOptions[0]?.[0] || '';

  const invite = async () => {
    setMessage(null);
    try {
      await api(`/api/businesses/${businessId}/invitations`, {
        method: 'POST',
        body: { email, roleIds: [selectedRole] },
      });
      setMessage({ text: `Invitation sent to ${email}.`, tone: 'success' });
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['members', businessId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  return (
    <Page title="Staff and invitations">
      <Alert message={members.error ? errorText(members.error) : null} />
      <table className="mb-6 w-full border-collapse bg-white text-left">
        <caption className="sr-only">Members of this business</caption>
        <thead>
          <tr>
            <th scope="col" className="border-b p-2">
              Name
            </th>
            <th scope="col" className="border-b p-2">
              Email
            </th>
            <th scope="col" className="border-b p-2">
              Roles
            </th>
          </tr>
        </thead>
        <tbody>
          {(members.data?.members ?? []).map((m) => (
            <tr key={m.membershipId}>
              <td className="border-b p-2">{m.displayName}</td>
              <td className="border-b p-2 break-all">{m.email}</td>
              <td className="border-b p-2">{m.roles.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mb-2 text-xl font-semibold">Invite a staff member</h2>
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void invite();
        }}
      >
        <Field label="Email" name="inviteEmail" type="email" value={email} onChange={setEmail} />
        <NativeSelect label="Role" name="role" value={selectedRole} onChange={setRoleId} options={roleOptions} />
        <Button type="submit">Send invitation</Button>
      </Form>
    </Page>
  );
}
