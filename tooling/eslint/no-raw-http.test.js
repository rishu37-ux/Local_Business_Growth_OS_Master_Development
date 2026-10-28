import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';
import rule from './no-raw-http.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2023, sourceType: 'module' } });

tester.run('no-raw-http', rule, {
  valid: [
    "import { guardedRequest } from '@lbgos/modules/outbound';",
    "import { readFile } from 'node:fs/promises';",
    'const r = await guardedRequest(url);',
    'obj.fetch();',
    "import crypto from 'node:crypto';",
  ],
  invalid: [
    { code: "import https from 'node:https';", errors: [{ messageId: 'importBanned' }] },
    { code: "import { request } from 'http';", errors: [{ messageId: 'importBanned' }] },
    { code: "import { fetch } from 'undici';", errors: [{ messageId: 'importBanned' }] },
    { code: "import axios from 'axios';", errors: [{ messageId: 'importBanned' }] },
    { code: "import net from 'node:net';", errors: [{ messageId: 'importBanned' }] },
    { code: "export { request } from 'node:http';", errors: [{ messageId: 'importBanned' }] },
    { code: "const m = await import('node:https');", errors: [{ messageId: 'importBanned' }] },
    { code: "const h = require('https');", errors: [{ messageId: 'importBanned' }] },
    { code: "await fetch('https://169.254.169.254/');", errors: [{ messageId: 'fetch' }] },
    { code: 'await globalThis.fetch(url);', errors: [{ messageId: 'fetch' }] },
  ],
});
