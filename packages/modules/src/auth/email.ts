// Outgoing auth emails (verification, password reset). The provider is chosen
// when a sending domain exists (ADR-19, Q6); until then only these two
// implementations exist, and production must supply a real sender.

export interface AuthEmail {
  readonly to: string;
  readonly kind: 'verify-email' | 'reset-password';
  /** Link containing a single-use token. Must not be logged, except by DevConsoleEmailSender in local development. */
  readonly url: string;
}

export interface EmailSender {
  send(email: AuthEmail): Promise<void>;
}

/** Test double: keeps sent emails in memory. */
export class CapturingEmailSender implements EmailSender {
  readonly sent: AuthEmail[] = [];

  send(email: AuthEmail): Promise<void> {
    this.sent.push(email);
    return Promise.resolve();
  }

  last(to: string, kind: AuthEmail['kind']): AuthEmail | undefined {
    return this.sent.filter((e) => e.to === to && e.kind === kind).at(-1);
  }
}

/** Development only: prints the link so a developer can click it locally. */
export class DevConsoleEmailSender implements EmailSender {
  send(email: AuthEmail): Promise<void> {
    console.info(`[dev email] ${email.kind} for ${email.to}: ${email.url}`);
    return Promise.resolve();
  }
}
