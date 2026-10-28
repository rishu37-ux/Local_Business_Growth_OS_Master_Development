// Reminder types and templates (FR-REM-1, D-049). Templates may reference only
// recorded fields; a placeholder with no recorded value skips that customer.

export const REMINDER_TYPES = ['BIRTHDAY', 'WARRANTY_EXPIRY', 'SERVICE_DUE', 'PAYMENT_DUE'] as const;
export type ReminderType = (typeof REMINDER_TYPES)[number];

export const PLACEHOLDERS = [
  'name',
  'shop',
  'model',
  'imei_last4',
  'warranty_end',
  'amount_due',
  'service_date',
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** Placeholders each reminder type can fill. */
export const TYPE_PLACEHOLDERS: Readonly<Record<ReminderType, readonly Placeholder[]>> = {
  BIRTHDAY: ['name', 'shop'],
  WARRANTY_EXPIRY: ['name', 'shop', 'model', 'imei_last4', 'warranty_end'],
  SERVICE_DUE: ['name', 'shop', 'model', 'imei_last4', 'service_date'],
  PAYMENT_DUE: ['name', 'shop', 'amount_due'],
};

/** Birthday, warranty and service reminders are promotional; payment due is transactional (D-049). */
export const REMINDER_PURPOSE: Readonly<Record<ReminderType, 'MARKETING' | 'TRANSACTIONAL'>> = {
  BIRTHDAY: 'MARKETING',
  WARRANTY_EXPIRY: 'MARKETING',
  SERVICE_DUE: 'MARKETING',
  PAYMENT_DUE: 'TRANSACTIONAL',
};

export const DEFAULT_TEMPLATES: Readonly<Record<ReminderType, string>> = {
  BIRTHDAY: 'Happy birthday, {name}! Best wishes from {shop}.',
  WARRANTY_EXPIRY:
    'Hello {name}, the warranty on your {model} (IMEI ending {imei_last4}) ends on {warranty_end}. — {shop}',
  SERVICE_DUE: 'Hello {name}, your {model} is due for a check-up from {service_date}. Visit {shop} any time.',
  PAYMENT_DUE: 'Hello {name}, {amount_due} is due at {shop}. Thank you.',
};

/** Default `days`: birthday on the day, warranty 15 days ahead, service 180 days after the sale, payment 30 days overdue. */
export const DEFAULT_DAYS: Readonly<Record<ReminderType, number>> = {
  BIRTHDAY: 0,
  WARRANTY_EXPIRY: 15,
  SERVICE_DUE: 180,
  PAYMENT_DUE: 30,
};

const TOKEN = /\{([^{}]*)\}/g;

/** Placeholders used by `template`, in order of first use. */
export function templatePlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TOKEN)) {
    const p = String(m[1]); // the group always matches (possibly empty)
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Problems that refuse a template when it is saved: unknown placeholders, or ones the type cannot fill; stray braces. */
export function templateProblems(type: ReminderType, template: string): string[] {
  const problems: string[] = [];
  if (template.trim() === '') problems.push('The text is empty.');
  for (const p of templatePlaceholders(template)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(p)) problems.push(`Unknown placeholder {${p}}.`);
    else if (!TYPE_PLACEHOLDERS[type].includes(p as Placeholder)) {
      problems.push(`{${p}} is not available for this reminder.`);
    }
  }
  if (/[{}]/.test(template.replace(TOKEN, ''))) problems.push('Unmatched { or }.');
  return problems;
}

/** Fills a (valid) template; when a used placeholder has no value, reports the missing ones instead. */
export function renderTemplate(
  template: string,
  values: Partial<Record<Placeholder, string | null>>,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly missing: Placeholder[] } {
  const missing = templatePlaceholders(template).filter((p) => {
    const v = values[p as Placeholder];
    return v === undefined || v === null || v.trim() === '';
  }) as Placeholder[];
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, text: template.replace(TOKEN, (_, p: string) => String(values[p as Placeholder])) };
}
