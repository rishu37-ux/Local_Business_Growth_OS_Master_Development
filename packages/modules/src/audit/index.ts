// Audit log writes (FR-AUD-1). Always called inside the transaction that makes
// the change, so the event and the change commit or roll back together.
// Metadata must hold identifiers and outcomes, never secrets or full personal data.
import { sql } from 'kysely';
import type { TenantContext, Trx } from '@lbgos/db';

export interface AuditEvent {
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly requestId?: string;
}

const ACTION = /^[a-z_]+(\.[a-z_]+)+$/;

function checkAction(action: string): void {
  if (!ACTION.test(action)) throw new Error(`invalid audit action: ${action}`);
}

/** A tenant-scope event, visible to the business (tenant role, RLS-checked). */
export async function recordTenantEvent(trx: Trx, ctx: TenantContext, event: AuditEvent): Promise<void> {
  checkAction(event.action);
  await sql`insert into lbg.audit_events (scope, business_id, actor_type, actor_user_id, action, target_type,
                                          target_id, request_id, metadata)
            values ('TENANT', ${ctx.businessId}, 'USER', ${ctx.userId}, ${event.action}, ${event.targetType ?? null},
                    ${event.targetId ?? null}, ${event.requestId ?? null}, ${JSON.stringify(event.metadata ?? {})}::jsonb)`.execute(
    trx,
  );
}

/** A platform-scope event (platform role). With businessId set, the business can see it too. */
export async function recordPlatformEvent(
  trx: Trx,
  actorUserId: string,
  event: AuditEvent & { readonly businessId?: string },
): Promise<void> {
  checkAction(event.action);
  await sql`insert into lbg.audit_events (scope, business_id, actor_type, actor_user_id, action, target_type,
                                          target_id, request_id, metadata)
            values ('PLATFORM', ${event.businessId ?? null}, 'PLATFORM_ADMIN', ${actorUserId}, ${event.action},
                    ${event.targetType ?? null}, ${event.targetId ?? null}, ${event.requestId ?? null},
                    ${JSON.stringify(event.metadata ?? {})}::jsonb)`.execute(trx);
}
