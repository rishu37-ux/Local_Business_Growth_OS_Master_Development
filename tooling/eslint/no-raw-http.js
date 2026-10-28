// ESLint rule for FR-HUB-5 AC1: all outbound HTTP goes through the guarded
// client in packages/modules/src/outbound/. Server code may not import
// network libraries or call the global fetch; the browser app and tests are
// not linted with this rule.

const BANNED = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'undici',
  'axios',
  'node-fetch',
  'got',
  'superagent',
  'request',
]);
const bare = (source) => source.replace(/^node:/, '').split('/')[0];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Outbound HTTP only through the guarded client (FR-HUB-5)' },
    schema: [],
    messages: {
      importBanned: "Do not import '{{source}}' here: outbound requests go through @lbgos/modules/outbound (FR-HUB-5).",
      fetch: 'Do not call fetch here: outbound requests go through @lbgos/modules/outbound (FR-HUB-5).',
    },
  },
  create(context) {
    function checkSource(node) {
      const source = node.source?.value;
      if (typeof source === 'string' && BANNED.has(bare(source))) {
        context.report({ node: node.source, messageId: 'importBanned', data: { source } });
      }
    }
    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression: checkSource,
      CallExpression(node) {
        const c = node.callee;
        const isFetch =
          (c.type === 'Identifier' && c.name === 'fetch') ||
          (c.type === 'MemberExpression' &&
            !c.computed &&
            c.property.type === 'Identifier' &&
            c.property.name === 'fetch' &&
            c.object.type === 'Identifier' &&
            ['globalThis', 'window', 'global', 'self'].includes(c.object.name));
        if (isFetch) context.report({ node, messageId: 'fetch' });
        if (
          c.type === 'Identifier' &&
          c.name === 'require' &&
          node.arguments[0]?.type === 'Literal' &&
          typeof node.arguments[0].value === 'string' &&
          BANNED.has(bare(node.arguments[0].value))
        ) {
          context.report({ node, messageId: 'importBanned', data: { source: node.arguments[0].value } });
        }
      },
    };
  },
};
