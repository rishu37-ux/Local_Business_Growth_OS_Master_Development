// Small accessible building blocks on React Aria Components (NFR-1).
import type { ReactNode } from 'react';
import { Button as AriaButton, FieldError, Input, Label, TextField } from 'react-aria-components';

/**
 * A page: heading block (optional eyebrow, description and actions) and a
 * body whose top-level <section>s render as cards. `narrow` is for sign-in
 * style pages, which are centred with the brand mark above them.
 */
export function Page(props: {
  title: string;
  children: ReactNode;
  eyebrow?: string;
  description?: ReactNode;
  actions?: ReactNode;
  narrow?: boolean;
}) {
  if (props.narrow) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] w-full items-start justify-center px-4 py-10 sm:py-16">
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <BrandMark className="mx-auto mb-4 h-11 w-11" />
            <h1 className="text-2xl font-semibold">{props.title}</h1>
            {props.description ? <p className="mt-2 text-sm text-ink-600">{props.description}</p> : null}
          </div>
          <div className="page-body rounded-2xl border border-ink-200 bg-white p-6 shadow-[var(--shadow-raised)] sm:p-8">
            {props.children}
          </div>
        </div>
      </main>
    );
  }
  return (
    <main className="mx-auto w-full max-w-6xl min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {props.eyebrow ? (
            <p className="mb-1 text-xs font-semibold tracking-wider text-brand-700 uppercase">{props.eyebrow}</p>
          ) : null}
          <h1 className="text-2xl font-semibold break-words sm:text-[1.75rem]">{props.title}</h1>
          {props.description ? <div className="mt-1 text-sm text-ink-600">{props.description}</div> : null}
        </div>
        {props.actions ? <div className="flex flex-wrap gap-2">{props.actions}</div> : null}
      </div>
      <div className="page-body min-w-0">{props.children}</div>
    </main>
  );
}

/** The product mark: a rounded square with a rising-bars glyph. Decorative. */
export function BrandMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={props.className ?? 'h-8 w-8'} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="lbg-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b5bd6" />
          <stop offset="1" stopColor="#302b86" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill="url(#lbg-mark)" />
      <rect x="10" y="21" width="5" height="9" rx="1.5" fill="#fff" opacity="0.65" />
      <rect x="17.5" y="15" width="5" height="15" rx="1.5" fill="#fff" opacity="0.85" />
      <rect x="25" y="9" width="5" height="21" rx="1.5" fill="#fff" />
    </svg>
  );
}

/** A status pill; `tone` picks the colour, the text carries the meaning. */
export function Badge(props: { children: ReactNode; tone?: 'success' | 'warning' | 'neutral' | 'danger' }) {
  return <span className={`badge badge-${props.tone ?? 'neutral'}`}>{props.children}</span>;
}

/** Tone for a status word such as ACTIVE, PENDING_APPROVAL or SUSPENDED. */
export function statusTone(status: string): 'success' | 'warning' | 'neutral' | 'danger' {
  if (['ACTIVE', 'POSTED', 'ISSUED', 'EXECUTED', 'COMPLETED', 'APPROVED', 'PAID'].includes(status)) return 'success';
  if (['SUSPENDED', 'REJECTED', 'CANCELLED', 'FAILED', 'EXECUTION_FAILED', 'REVERSED'].includes(status))
    return 'danger';
  if (status.includes('PENDING') || status.includes('CHANGES') || status.includes('SETUP') || status === 'DRAFT')
    return 'warning';
  return 'neutral';
}

export const humanize = (status: string) => {
  const t = status.replaceAll('_', ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const INPUT =
  'w-full max-w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-base text-ink-900 shadow-[var(--shadow-card)] transition placeholder:text-ink-400 hover:border-ink-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-100 focus:outline-none data-[invalid]:border-red-700';

export function Field(props: {
  label: string;
  name: string;
  type?: 'text' | 'email' | 'password';
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  isRequired?: boolean;
  inputMode?: 'numeric' | 'text';
  description?: string;
}) {
  return (
    <TextField
      className="mb-3 flex flex-col gap-1"
      name={props.name}
      type={props.type ?? 'text'}
      value={props.value}
      onChange={props.onChange}
      isRequired={props.isRequired ?? true}
      {...(props.autoComplete ? { autoComplete: props.autoComplete } : {})}
      {...(props.inputMode ? { inputMode: props.inputMode } : {})}
    >
      <Label className="text-sm font-medium text-ink-800">{props.label}</Label>
      <Input className={INPUT} />
      {props.description ? <p className="text-sm text-ink-600">{props.description}</p> : null}
      <FieldError className="text-sm text-red-800" />
    </TextField>
  );
}

export function Button(props: {
  children: ReactNode;
  type?: 'submit' | 'button';
  onPress?: () => void;
  isDisabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const color =
    props.variant === 'danger'
      ? 'bg-red-700 text-white shadow-[var(--shadow-card)] hover:bg-red-800'
      : props.variant === 'secondary'
        ? 'border border-ink-300 bg-white text-ink-800 shadow-[var(--shadow-card)] hover:border-ink-400 hover:bg-ink-50'
        : 'bg-brand-600 text-white shadow-[var(--shadow-card)] hover:bg-brand-700';
  return (
    <AriaButton
      type={props.type ?? 'button'}
      {...(props.onPress ? { onPress: props.onPress } : {})}
      isDisabled={props.isDisabled ?? false}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${color} cursor-pointer disabled:cursor-not-allowed disabled:opacity-55`}
    >
      {props.children}
    </AriaButton>
  );
}

/** Announced to screen readers when it appears. */
export function Alert(props: { message: string | null; tone?: 'error' | 'success' }) {
  if (!props.message) return <div aria-live="polite" />;
  const success = props.tone === 'success';
  const tone = success ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900';
  return (
    <div
      role={success ? 'status' : 'alert'}
      className={`mb-4 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${tone}`}
    >
      <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
        {success ? (
          <path
            fill="currentColor"
            d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm4.2 6.3-5 5a.9.9 0 0 1-1.3 0l-2.1-2.1a.9.9 0 1 1 1.3-1.3l1.5 1.5 4.3-4.4a.9.9 0 0 1 1.3 1.3Z"
          />
        ) : (
          <path
            fill="currentColor"
            d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm0 4a.9.9 0 0 1 .9.9v4.2a.9.9 0 0 1-1.8 0V6.4a.9.9 0 0 1 .9-.9Zm0 9.3a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Z"
          />
        )}
      </svg>
      <span>{props.message}</span>
    </div>
  );
}

export function NativeSelect(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
}) {
  const id = `select-${props.name}`;
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink-800">
        {props.label}
      </label>
      <select
        id={id}
        name={props.name}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        className={INPUT}
      >
        {props.options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

export function Checkbox(props: {
  label: string;
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = `check-${props.name}`;
  return (
    <div className="mb-3 flex items-center gap-2">
      <input
        id={id}
        type="checkbox"
        name={props.name}
        checked={props.checked}
        onChange={(e) => {
          props.onChange(e.target.checked);
        }}
        className="h-5 w-5 rounded border-ink-300 accent-brand-600"
      />
      <label htmlFor={id} className="text-sm text-ink-800">
        {props.label}
      </label>
    </div>
  );
}

export function TextArea(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  rows?: number;
}) {
  const id = `textarea-${props.name}`;
  const hint = `${id}-hint`;
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink-800">
        {props.label}
      </label>
      <textarea
        id={id}
        name={props.name}
        rows={props.rows ?? 3}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        {...(props.description ? { 'aria-describedby': hint } : {})}
        className={`${INPUT} font-mono`}
      />
      {props.description ? (
        <p id={hint} className="text-sm text-ink-600">
          {props.description}
        </p>
      ) : null}
    </div>
  );
}

/** A plain data table with a caption (visually hidden) and header cells. */
export function Table(props: { caption: string; headers: readonly string[]; children: ReactNode }) {
  return (
    // Focusable so keyboard users can scroll a wide table on small screens (WCAG 2.1.1).
    // `relative` keeps absolutely positioned content (screen-reader-only text) inside the scroller.
    <div
      className="relative mb-4 overflow-x-auto rounded-xl border border-ink-200 bg-white"
      tabIndex={0}
      role="region"
      aria-label={props.caption}
    >
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{props.caption}</caption>
        <thead>
          <tr>
            {props.headers.map((h) => (
              <th key={h} scope="col" className="px-3 py-2.5 whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}

export const cell = 'border-b border-ink-100 px-3 py-2.5 align-top';
