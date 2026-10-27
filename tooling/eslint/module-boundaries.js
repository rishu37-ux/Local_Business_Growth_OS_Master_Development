// ESLint rule enforcing modular-monolith boundaries (NFR-2, ADR-03).
//
// Business modules live in packages/modules/src/<module>/. Code may import another
// module only through that module's public entry point (<module>/index.ts).
// Deep imports into workspace packages (`@lbgos/<pkg>/src/...`) are also
// forbidden; packages expose their API through package.json "exports".
import path from 'node:path';

const MODULES_ROOT = path.join('packages', 'modules', 'src');

function moduleOf(absPath, repoRoot) {
  const rel = path.relative(path.join(repoRoot, MODULES_ROOT), absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const [name, ...rest] = rel.split(path.sep);
  return { name, rest: rest.join('/') };
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Allow cross-module imports only through a module index.ts' },
    schema: [
      {
        type: 'object',
        properties: { repoRoot: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      internal: "Import of module '{{target}}' internals ('{{source}}'). Import from its index.ts instead.",
      deep: "Deep import '{{source}}' into a workspace package. Use the package's exported entry point.",
    },
  },
  create(context) {
    const repoRoot = context.options[0]?.repoRoot ?? context.cwd;
    const filename = context.filename;
    const from = moduleOf(filename, repoRoot);

    function check(node) {
      const source = node.source?.value;
      if (typeof source !== 'string') return;

      if (/^@lbgos\/[^/]+\/src(\/|$)/.test(source)) {
        context.report({ node: node.source, messageId: 'deep', data: { source } });
        return;
      }
      if (!source.startsWith('.')) return;

      const target = moduleOf(path.resolve(path.dirname(filename), source), repoRoot);
      if (!target || target.name === from?.name) return;
      const publicEntry = target.rest === '' || target.rest === 'index.ts' || target.rest === 'index';
      if (!publicEntry) {
        context.report({ node: node.source, messageId: 'internal', data: { target: target.name, source } });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};
