import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/**/*.db.test.ts'], fileParallelism: false } });
