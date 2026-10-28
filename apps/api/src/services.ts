import type { Db } from '@lbgos/db';
import type { AuthService } from '@lbgos/modules/auth';
import type { MessageProvider } from '@lbgos/modules/messaging';
import type { Keyring } from '@lbgos/modules/secrets';
import type { OutboundOptions } from '@lbgos/modules/outbound';
import type { Mailer } from '@lbgos/modules/notifications';
import type { OcrConfig } from '@lbgos/modules/ocr';
import type { PdfRenderer } from './pdf.ts';

/** Everything route handlers need; one pool per database role (ADR-07). */
export interface AppServices {
  readonly appDb: Db;
  readonly platformDb: Db;
  readonly auth: AuthService;
  readonly mailer: Mailer;
  /** Public origin, for links in emails. */
  readonly baseURL: string;
  /** Upload storage and OCR processing; without it the scan routes are not registered. */
  readonly ocr?: OcrConfig;
  /** PDF rendering of printed documents; without it PDF downloads answer 503. */
  readonly pdf?: PdfRenderer;
  /** Messaging provider adapter; without it messages fail as PROVIDER_NOT_CONFIGURED (none is connected yet). */
  readonly messaging?: MessageProvider;
  /** Integration secrets (ADR-13): the secrets-role pool and the key-encryption keys; without them the store is "not configured". */
  readonly secrets?: { readonly db: Db; readonly keyring: Keyring };
  /** API Hub: mock adapters (never in production) and DNS/transport injection for tests. */
  readonly integrations?: {
    readonly allowMocks: boolean;
    readonly outbound?: Pick<OutboundOptions, 'resolver' | 'transport'>;
    readonly retryBaseMs?: number;
  };
}
