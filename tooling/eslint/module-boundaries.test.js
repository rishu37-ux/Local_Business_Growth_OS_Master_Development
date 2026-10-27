import path from 'node:path';
import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';
import rule from './module-boundaries.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const root = '/repo';
const options = [{ repoRoot: root }];
const file = (rel) => path.join(root, rel);
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2023, sourceType: 'module' } });

tester.run('module-boundaries', rule, {
  valid: [
    {
      code: "import { x } from '../tenancy/index.ts';",
      filename: file('packages/modules/src/rbac/service.ts'),
      options,
    },
    { code: "import { x } from '../tenancy';", filename: file('packages/modules/src/rbac/service.ts'), options },
    {
      code: "import { x } from './internal/repo.ts';",
      filename: file('packages/modules/src/rbac/service.ts'),
      options,
    },
    { code: "import { x } from '../shared.ts';", filename: file('packages/modules/src/rbac/internal/a.ts'), options },
    { code: "import { isValidImei } from '@lbgos/domain';", filename: file('apps/api/src/app.ts'), options },
    {
      code: "import { tenancy } from '../../../packages/modules/src/tenancy/index.ts';",
      filename: file('apps/api/src/app.ts'),
      options,
    },
  ],
  invalid: [
    {
      code: "import { repo } from '../tenancy/internal/repo.ts';",
      filename: file('packages/modules/src/rbac/service.ts'),
      options,
      errors: [{ messageId: 'internal' }],
    },
    {
      code: "export * from '../audit/store.ts';",
      filename: file('packages/modules/src/rbac/index.ts'),
      options,
      errors: [{ messageId: 'internal' }],
    },
    {
      code: "const m = import('../tenancy/internal/repo.ts');",
      filename: file('packages/modules/src/rbac/service.ts'),
      options,
      errors: [{ messageId: 'internal' }],
    },
    {
      code: "import { x } from '../../../packages/modules/src/tenancy/internal/repo.ts';",
      filename: file('apps/api/src/app.ts'),
      options,
      errors: [{ messageId: 'internal' }],
    },
    {
      code: "import { luhn } from '@lbgos/domain/src/imei.ts';",
      filename: file('apps/api/src/app.ts'),
      options,
      errors: [{ messageId: 'deep' }],
    },
  ],
});
