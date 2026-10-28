import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { Alert, Button, errorText, Page } from '../ui.tsx';

export function InvitePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const token = params.get('token') ?? '';

  const accept = async () => {
    setError(null);
    try {
      const { businessId } = await api<{ businessId: string }>('/api/invitations/accept', {
        method: 'POST',
        body: { token },
      });
      await queryClient.invalidateQueries();
      void navigate(`/b/${businessId}`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Page narrow title="Join a business">
      <Alert message={error} />
      <p className="mb-3">You have been invited to join a business on Local Business Growth OS.</p>
      <Button onPress={() => void accept()}>Accept invitation</Button>
    </Page>
  );
}
