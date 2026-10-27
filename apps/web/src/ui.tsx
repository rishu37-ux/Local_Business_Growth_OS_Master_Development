// Small accessible building blocks on React Aria Components (NFR-1).
import type { ReactNode } from 'react';
import { Button as AriaButton, FieldError, Input, Label, TextField } from 'react-aria-components';

export function Page(props: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-semibold">{props.title}</h1>
      {props.children}
    </main>
  );
}

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
      <Label className="font-medium">{props.label}</Label>
      <Input className="rounded border border-slate-400 bg-white px-3 py-2 text-base" />
      {props.description ? <p className="text-sm text-slate-700">{props.description}</p> : null}
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
      ? 'bg-red-800 text-white'
      : props.variant === 'secondary'
        ? 'border border-slate-500 bg-white text-slate-900'
        : 'bg-blue-800 text-white';
  return (
    <AriaButton
      type={props.type ?? 'button'}
      {...(props.onPress ? { onPress: props.onPress } : {})}
      isDisabled={props.isDisabled ?? false}
      className={`min-h-11 rounded px-4 py-2 font-medium ${color} disabled:opacity-60`}
    >
      {props.children}
    </AriaButton>
  );
}

/** Announced to screen readers when it appears. */
export function Alert(props: { message: string | null; tone?: 'error' | 'success' }) {
  if (!props.message) return <div aria-live="polite" />;
  const tone =
    props.tone === 'success' ? 'border-green-700 bg-green-50 text-green-900' : 'border-red-700 bg-red-50 text-red-900';
  return (
    <div role={props.tone === 'success' ? 'status' : 'alert'} className={`mb-3 rounded border px-3 py-2 ${tone}`}>
      {props.message}
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
      <label htmlFor={id} className="font-medium">
        {props.label}
      </label>
      <select
        id={id}
        name={props.name}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        className="rounded border border-slate-400 bg-white px-3 py-2 text-base"
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
