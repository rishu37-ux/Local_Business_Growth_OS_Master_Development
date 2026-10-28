// Hub dependencies and the message provider for a request (7.3, 7.6). Without
// an injected provider (tests), messages go through the business's tested
// WhatsApp or SMS integration; with none, they fail as PROVIDER_NOT_CONFIGURED.
import type { FastifyRequest } from 'fastify';
import { hubMessagingProvider } from '@lbgos/modules/channels';
import type { HubDeps } from '@lbgos/modules/integrations';
import type { MessageProvider } from '@lbgos/modules/messaging';
import type { AppServices } from './services.ts';

export const hubDepsOf = (s: AppServices): HubDeps => ({
  appDb: s.appDb,
  secrets: s.secrets ?? null,
  allowMocks: s.integrations?.allowMocks ?? false,
  outbound: s.integrations?.outbound,
  retryBaseMs: s.integrations?.retryBaseMs,
});

export function messagingProviderFor(s: AppServices, request: FastifyRequest): Promise<MessageProvider> {
  if (s.messaging) return Promise.resolve(s.messaging);
  return hubMessagingProvider(hubDepsOf(s), {
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
}
