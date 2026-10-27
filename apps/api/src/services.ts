import type { Db } from '@lbgos/db';
import type { AuthService } from '@lbgos/modules/auth';
import type { Mailer } from '@lbgos/modules/notifications';
import type { OcrConfig } from '@lbgos/modules/ocr';

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
}
