// Provider templates for business-initiated messages (increment 7.6: FR-MSG-1
// AC1, FR-MSG-2, D-059). A WhatsApp business-initiated message is sent only as
// an approved template; an SMS only with a matching DLT-registered template.
// Marketing messages match only marketing (promotional) templates, and
// transactional messages only non-marketing ones, so the two never mix.

export type TemplateChannel = 'WHATSAPP' | 'SMS';
export type TemplatePurpose = 'MARKETING' | 'TRANSACTIONAL';

export interface ChannelTemplate {
  readonly id: string;
  readonly channel: TemplateChannel;
  readonly purpose: TemplatePurpose;
  /** WhatsApp: "{{1}}" placeholders; DLT: "{#var#}" placeholders. */
  readonly body: string;
  readonly status: string;
}

export interface TemplateMatch<T extends ChannelTemplate = ChannelTemplate> {
  readonly template: T;
  /** Placeholder values in template order ({{1}}, {{2}}, … or each {#var#}). */
  readonly params: readonly string[];
}

/** DLT allows up to 30 characters per variable. */
export const DLT_VAR_MAX = 30;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(t: Pick<ChannelTemplate, 'channel' | 'body'>): { re: RegExp; order: number[] } | null {
  const order: number[] = [];
  let source = '';
  if (t.channel === 'WHATSAPP') {
    const parts = t.body.split(/\{\{(\d+)\}\}/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) source += escape(parts[i] ?? '');
      else {
        order.push(Number(parts[i]));
        // A WhatsApp parameter cannot contain new lines or tabs.
        source += '([^\\n\\t]+?)';
      }
    }
    // Placeholders must be {{1}}…{{n}} without gaps or repeats.
    const sorted = [...order].sort((a, b) => a - b);
    if (sorted.some((n, i) => n !== i + 1)) return null;
  } else {
    const parts = t.body.split('{#var#}');
    source = parts.map(escape).join(`([^\\n]{1,${String(DLT_VAR_MAX)}}?)`);
    for (let i = 1; i < parts.length; i++) order.push(i);
  }
  return { re: new RegExp(`^${source}$`, 's'), order };
}

/** Whether a template body is well-formed for its channel (placeholders in order). */
export const templateBodyValid = (t: Pick<ChannelTemplate, 'channel' | 'body'>) =>
  t.body.trim().length > 0 && compile(t) !== null;

/**
 * The approved template of the right channel and purpose whose text, with its
 * placeholders filled, is exactly `text`; the first match in the given order.
 */
export function matchTemplate<T extends ChannelTemplate>(
  text: string,
  templates: readonly T[],
  want: { readonly channel: TemplateChannel; readonly purpose: TemplatePurpose },
): TemplateMatch<T> | null {
  const body = text.trim();
  for (const t of templates) {
    if (t.channel !== want.channel || t.purpose !== want.purpose || t.status !== 'APPROVED') continue;
    const c = compile(t);
    const m = c ? c.re.exec(body) : null;
    if (!c || !m) continue;
    const values = m.slice(1).map((v) => v.trim());
    if (values.some((v) => v === '')) continue;
    // Captures are in text order; parameters go in placeholder-number order.
    const params: string[] = [];
    c.order.forEach((n, i) => (params[n - 1] = values[i] ?? ''));
    return { template: t, params };
  }
  return null;
}

/** WhatsApp template categories: MARKETING is marketing; UTILITY and AUTHENTICATION are transactional. */
export const whatsappPurpose = (category: string): TemplatePurpose =>
  category.toUpperCase() === 'MARKETING' ? 'MARKETING' : 'TRANSACTIONAL';

// ---------------------------------------------------------------------------
// Non-secret channel configuration (checked when an integration is saved)
// ---------------------------------------------------------------------------

export interface WhatsAppConfig {
  readonly phoneNumberId: string;
  readonly wabaId: string;
}
export interface DltConfig {
  /** DLT principal entity ID. */
  readonly dltEntityId: string;
  /** Registered headers (sender IDs) per purpose. */
  readonly headers: { readonly TRANSACTIONAL?: string; readonly MARKETING?: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks the configuration a provider needs; returns the problem or null.
 * Header formats follow the commonly published TRAI DLT rules (6 letters for
 * transactional/service, 6 digits for promotional); to be confirmed against
 * current regulations before the pilot (FR-MSG-2 AC2).
 */
export function channelConfigProblem(provider: string, config: unknown): string | null {
  if (provider === 'whatsapp_cloud') {
    if (!isObject(config)) return 'The phone number ID and WhatsApp Business Account ID are required.';
    if (typeof config.phoneNumberId !== 'string' || !/^\d{5,20}$/.test(config.phoneNumberId))
      return 'The phone number ID must be the numeric ID shown by Meta.';
    if (typeof config.wabaId !== 'string' || !/^\d{5,20}$/.test(config.wabaId))
      return 'The WhatsApp Business Account ID must be the numeric ID shown by Meta.';
    return Object.keys(config).length === 2 ? null : 'Unknown configuration fields.';
  }
  if (provider === 'sms_dlt_json') {
    if (!isObject(config)) return 'The DLT entity ID and at least one registered header are required.';
    if (typeof config.dltEntityId !== 'string' || !/^\d{12,20}$/.test(config.dltEntityId))
      return 'The DLT entity ID must be the numeric ID from the DLT portal.';
    const h = config.headers;
    if (!isObject(h) || Object.keys(h).length === 0) return 'At least one registered header is required.';
    for (const [k, v] of Object.entries(h)) {
      if (k === 'TRANSACTIONAL' && (typeof v !== 'string' || !/^[A-Z]{6}$/.test(v)))
        return 'A transactional header has 6 capital letters.';
      if (k === 'MARKETING' && (typeof v !== 'string' || !/^\d{6}$/.test(v)))
        return 'A promotional header has 6 digits.';
      if (k !== 'TRANSACTIONAL' && k !== 'MARKETING') return 'Headers are TRANSACTIONAL or MARKETING.';
    }
    return Object.keys(config).length === 2 ? null : 'Unknown configuration fields.';
  }
  // The mock may name a test store (its marketplace orders and pushes are kept per store, 11.2).
  if (provider === 'mock' && isObject(config) && Object.keys(config).length === 1 && 'store' in config)
    return typeof config.store === 'string' && /^[a-z0-9-]{1,40}$/.test(config.store) ? null : 'Invalid test store.';
  return isObject(config) && Object.keys(config).length === 0 ? null : 'This provider takes no configuration.';
}
