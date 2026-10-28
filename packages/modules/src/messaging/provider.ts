// Messaging provider adapter (FR-MSG-1, ADR-19, D-048). No provider is
// connected in this phase (WhatsApp Business Platform, SMS/DLT and email are
// `planned`); the production default is NOT_CONFIGURED, so nothing is sent.
import type { MessageChannel } from '@lbgos/domain';

export interface OutboundMessage {
  readonly messageId: string;
  readonly channel: MessageChannel;
  readonly to: string;
  readonly body: string;
}

/** `ok` means the provider accepted the message and returned its reference — not that it was delivered. */
export type ProviderResult =
  { readonly ok: true; readonly providerMessageId: string } | { readonly ok: false; readonly code: string };

export interface MessageProvider {
  /** Short name stored with provider statuses, e.g. "whatsapp-cloud". */
  readonly name: string;
  readonly configured: boolean;
  send(message: OutboundMessage): Promise<ProviderResult>;
}

export const NOT_CONFIGURED: MessageProvider = {
  name: 'none',
  configured: false,
  send: () => Promise.resolve({ ok: false, code: 'PROVIDER_NOT_CONFIGURED' }),
};
