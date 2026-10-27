// The current business and the member's usable permissions (for showing the
// right screens; the API enforces every permission itself).
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';

export interface BusinessView {
  business: { legal_name: string; display_name: string | null; status: string };
  access: { mode: string; roles: string[]; permissions: string[] };
}

export function useBusiness(businessId: string) {
  const query = useQuery({
    queryKey: ['business', businessId],
    queryFn: () => api<BusinessView>(`/api/businesses/${businessId}`),
    retry: false,
  });
  const permissions = new Set(query.data?.access.permissions ?? []);
  return { ...query, can: (permission: string) => permissions.has(permission) };
}
