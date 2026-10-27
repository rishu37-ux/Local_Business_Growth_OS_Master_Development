// Prints the SQL Better Auth needs for the configured plugins, compiled
// against the current database (run inside scripts/with-throwaway-pg.sh after
// migrations). The output is reviewed and committed as a migration; Better
// Auth never creates tables at runtime.
//
// Usage: ../../scripts/with-throwaway-pg.sh sh -c \
//   'node ../db/src/migrate-cli.ts >/dev/null && node scripts/generate-auth-schema.ts'
import { getMigrations } from 'better-auth/db/migration';
import { createDb } from '@lbgos/db';
import { buildAuthOptions, CapturingEmailSender } from '../src/auth/index.ts';

const db = createDb('lbgos_auth', { max: 1 });
try {
  const options = buildAuthOptions({
    baseURL: 'http://localhost:3000',
    secret: 'generator-only-secret-not-used-for-anything-real',
    secureCookies: false,
    email: new CapturingEmailSender(),
    db,
  });
  const { compileMigrations } = await getMigrations(options);
  console.log(await compileMigrations());
} finally {
  await db.destroy();
}
