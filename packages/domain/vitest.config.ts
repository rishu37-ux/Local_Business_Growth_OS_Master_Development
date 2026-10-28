import { defineConfig } from 'vitest/config';

// FR-TAX-1 AC5: the tax engine (and the other money modules) must keep ≥95 %
// branch coverage; `pnpm test` fails below the threshold. The messaging
// send-time gate (FR-CON-1) is held to the same bar.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: [
        'src/tax-engine.ts',
        'src/allocation.ts',
        'src/money.ts',
        'src/numbering.ts',
        'src/purchase.ts',
        'src/discount-limits.ts',
        'src/messaging.ts',
        'src/reminders.ts',
      ],
      reporter: ['text'],
      thresholds: { branches: 95, lines: 95, functions: 95, statements: 95 },
    },
  },
});
