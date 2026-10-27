import { defineConfig } from 'vitest/config';

// DB tests need a running PostgreSQL (see the test:db script); they share one
// database, so files run sequentially.
export default defineConfig({
  test: { include: ['test/**/*.db.test.ts'], fileParallelism: false, testTimeout: 30_000 },
});
