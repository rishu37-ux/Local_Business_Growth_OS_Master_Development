// Process entry point: validate config, open role pools, serve, shut down cleanly.
import { sql } from 'kysely';
import { createDb, type Db, type PoolOptions } from '@lbgos/db';
import { createAuthService, DevConsoleEmailSender } from '@lbgos/modules/auth';
import { DevConsoleMailer } from '@lbgos/modules/notifications';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';

function fail(message: string): never {
  // Plain stderr: the logger is not configured yet, and messages hold no secret values.
  console.error(message);
  process.exit(1);
}

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  fail(err instanceof ConfigError ? err.message : 'invalid configuration');
}

const secret = config.SESSION_SECRET ?? fail('SESSION_SECRET is required (at least 32 characters)');
if (config.NODE_ENV === 'production') {
  // No transactional email provider is configured yet (ADR-19, open question Q6).
  fail('production start refused: no email provider is configured for verification and reset emails');
}

const pool = (url: string | undefined): PoolOptions => (url ? { connectionString: url } : {});
const appDb = createDb('lbgos_app', pool(config.DATABASE_URL_APP));
const platformDb = createDb('lbgos_platform', pool(config.DATABASE_URL_PLATFORM));
const authDb = createDb('lbgos_auth', pool(config.DATABASE_URL_AUTH));
const pools: Db[] = [appDb, platformDb, authDb];

const auth = createAuthService({
  baseURL: config.PUBLIC_BASE_URL,
  secret,
  secureCookies: config.PUBLIC_BASE_URL.startsWith('https://'),
  email: new DevConsoleEmailSender(),
  db: authDb,
});

const app = buildApp({
  config,
  services: { appDb, platformDb, auth, mailer: new DevConsoleMailer(), baseURL: config.PUBLIC_BASE_URL },
  readiness: {
    database: async () => {
      await sql`select 1`.execute(appDb);
    },
  },
});

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.all(pools.map((db) => db.destroy()));
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
