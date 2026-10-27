// Runtime configuration (increment 3.4 AC1). Read once at boot from the
// environment and validated; the process refuses to start on any problem.
// Error messages name the offending variables but never echo their values,
// because some of them are secrets.
import { z } from 'zod';

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
  .optional();

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // One URL per database role (ADR-07). When unset (local/test), libpq PG*
    // environment variables are used with the role name as the user.
    DATABASE_URL_APP: postgresUrl,
    DATABASE_URL_PLATFORM: postgresUrl,
    DATABASE_URL_AUTH: postgresUrl,
    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
    // Number of trusted reverse-proxy hops in front of the API (edge + platform router).
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_PLATFORM', 'DATABASE_URL_AUTH', 'SESSION_SECRET'] as const) {
      if (env[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
    }
  });

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only the variable name and the rule are reported, never the value.
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}
