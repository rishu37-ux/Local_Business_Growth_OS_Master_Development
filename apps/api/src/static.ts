// Serves the built web app from the same origin (ADR-05). Files are resolved
// strictly inside the build directory; unknown page paths get index.html
// (client-side routing), but never anything under /api.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Absolute path for `urlPath` inside `root`, or null if it escapes `root` or is not servable. */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const target = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).some((part) => part.startsWith('.'))) return null; // no dotfiles
  return TYPES[path.extname(target)] ? target : null;
}

export function registerWeb(app: FastifyInstance, root: string): void {
  const index = path.join(root, 'index.html');

  app.get('/*', { config: { public: true } }, async (request, reply) => {
    const urlPath = request.url.split('?')[0] ?? '/';
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
    }
    // Dot segments, dotfiles and encoded separators are never legitimate here:
    // answer 404 instead of falling back to the app shell.
    if (/(^|\/)\.|%2f|%5c|\\/i.test(urlPath)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
    }
    const file = urlPath === '/' ? null : resolveInside(root, urlPath);
    if (file && (await stat(file).catch(() => null))?.isFile()) {
      const body = await readFile(file);
      // Vite fingerprints everything under /assets, so those can be cached forever.
      void reply.header(
        'cache-control',
        urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      return reply.type(TYPES[path.extname(file)] ?? 'application/octet-stream').send(body);
    }
    if (path.extname(urlPath) !== '') {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
    }
    void reply.header('cache-control', 'no-cache');
    return reply.type(TYPES['.html'] ?? 'text/html').send(await readFile(index));
  });
}
