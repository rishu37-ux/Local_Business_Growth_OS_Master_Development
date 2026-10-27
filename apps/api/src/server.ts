// Process entry point: validate config, open role pools, serve, shut down cleanly.
import { sql } from 'kysely';
import { createDb, type Db } from '@lbgos/db';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  // Plain stderr: the logger is not configured yet, and the message holds no values.
  console.error(err instanceof ConfigError ? err.message : 'invalid configuration');
  process.exit(1);
}

const pools: Db[] = [
  createDb('lbgos_app', config.DATABASE_URL_APP ? { connectionString: config.DATABASE_URL_APP } : {}),
];
const [appDb] = pools as [Db];

const app = buildApp({
  config,
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
