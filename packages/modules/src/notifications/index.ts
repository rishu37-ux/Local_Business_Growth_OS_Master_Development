// Outgoing email for business events (invitations, lifecycle decisions) and
// in-app notifications (FR-ONB-3). The email provider is chosen when a sending
// domain exists (ADR-19, Q6); until then only these implementations exist.
import { sql } from 'kysely';
import { withUser, type Db } from '@lbgos/db';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain text. May contain single-use links: must not be logged outside local development. */
  readonly text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  last(to: string): MailMessage | undefined {
    return this.sent.filter((m) => m.to === to).at(-1);
  }
}

/** Development only: prints messages so links can be followed locally. */
export class DevConsoleMailer implements Mailer {
  send(message: MailMessage): Promise<void> {
    console.info(`[dev mail] to ${message.to}: ${message.subject}\n${message.text}`);
    return Promise.resolve();
  }
}

export interface Notification {
  readonly id: string;
  readonly businessId: string | null;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

export async function listNotifications(db: Db, userId: string): Promise<Notification[]> {
  return withUser(db, userId, async (trx) => {
    const { rows } = await sql<{
      id: string;
      business_id: string | null;
      kind: string;
      title: string;
      body: string;
      created_at: Date;
      read_at: Date | null;
    }>`select id, business_id, kind, title, body, created_at, read_at from lbg.notifications
        order by created_at desc limit 50`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      createdAt: r.created_at,
      readAt: r.read_at,
    }));
  });
}

export async function markNotificationRead(db: Db, userId: string, id: string): Promise<boolean> {
  return withUser(db, userId, async (trx) => {
    const res = await sql`update lbg.notifications set read_at = coalesce(read_at, now()) where id = ${id}`.execute(
      trx,
    );
    return Number(res.numAffectedRows ?? 0) > 0;
  });
}
