// Sign-in (with the TOTP step), sign-up and MFA enrolment screens.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { Alert, Button, errorText, Field, Page } from '../ui.tsx';

/** Only same-app relative paths are followed after sign-in (no open redirect). */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function SignInPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = async () => {
    await queryClient.invalidateQueries();
    void navigate(safeNext(params.get('next')));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (needsCode) {
        await api('/api/auth/two-factor/verify-totp', { method: 'POST', body: { code } });
        await done();
        return;
      }
      const res = await api<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', {
        method: 'POST',
        body: { email, password },
      });
      if (res.twoFactorRedirect) setNeedsCode(true);
      else await done();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Sign in">
      <Alert message={error} />
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {needsCode ? (
          <Field
            label="Six-digit code from your authenticator app"
            name="code"
            value={code}
            onChange={setCode}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
        ) : (
          <>
            <Field label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="username" />
            <Field
              label="Password"
              name="password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
          </>
        )}
        <Button type="submit" isDisabled={busy}>
          {needsCode ? 'Verify code' : 'Sign in'}
        </Button>
      </Form>
      <p className="mt-4">
        New here?{' '}
        <Link className="text-blue-800 underline" to="/sign-up">
          Create an account
        </Link>
      </p>
    </Page>
  );
}

export function SignUpPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    setError(null);
    try {
      await api('/api/auth/sign-up/email', { method: 'POST', body: { name, email, password, callbackURL: '/' } });
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Page title="Create an account">
      <Alert message={error} />
      {sent ? (
        <Alert tone="success" message="Check your email for a verification link, then sign in." />
      ) : (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Your name" name="name" value={name} onChange={setName} autoComplete="name" />
          <Field label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="email" />
          <Field
            label="Password"
            name="password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            description="At least 10 characters. Avoid common passwords."
          />
          <Button type="submit">Create account</Button>
        </Form>
      )}
      <p className="mt-4">
        Already registered?{' '}
        <Link className="text-blue-800 underline" to="/sign-in">
          Sign in
        </Link>
      </p>
    </Page>
  );
}

export function MfaPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    try {
      const res = await api<{ totpURI: string; backupCodes: string[] }>('/api/auth/two-factor/enable', {
        method: 'POST',
        body: { password },
      });
      setSetup({
        secret: new URL(res.totpURI).searchParams.get('secret') ?? '',
        uri: res.totpURI,
        backupCodes: res.backupCodes,
      });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const verify = async () => {
    setError(null);
    try {
      await api('/api/auth/two-factor/verify-totp', { method: 'POST', body: { code } });
      await queryClient.invalidateQueries();
      void navigate('/');
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Page title="Set up two-step verification">
      <Alert message={error} />
      {!setup ? (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <p className="mb-3">
            Owners and platform admins must use an authenticator app. Confirm your password to begin.
          </p>
          <Field
            label="Password"
            name="password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <Button type="submit">Continue</Button>
        </Form>
      ) : (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <p className="mb-2">Add this key to your authenticator app:</p>
          <p className="mb-3 break-all rounded bg-white p-3 font-mono" data-testid="totp-secret">
            {setup.secret}
          </p>
          <details className="mb-3">
            <summary>Backup codes (save them now; each works once)</summary>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">
              {setup.backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
          <Field
            label="Six-digit code"
            name="code"
            value={code}
            onChange={setCode}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
          <Button type="submit">Turn on</Button>
        </Form>
      )}
    </Page>
  );
}
