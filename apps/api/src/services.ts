import type { Db } from '@lbgos/db';
import type { AuthService } from '@lbgos/modules/auth';

/** Everything route handlers need; one pool per database role (ADR-07). */
export interface AppServices {
  readonly appDb: Db;
  readonly platformDb: Db;
  readonly auth: AuthService;
}
