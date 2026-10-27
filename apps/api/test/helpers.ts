import { Writable } from 'node:stream';
import { buildApp, type Readiness } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

/** Collects JSON log lines written by the app. */
export class LogCapture extends Writable {
  readonly lines: Record<string, unknown>[] = [];

  override _write(chunk: Buffer, _enc: BufferEncoding, done: (error?: Error | null) => void): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) this.lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    done();
  }

  get text(): string {
    return this.lines.map((l) => JSON.stringify(l)).join('\n');
  }
}

export const okReadiness: Readiness = { database: () => Promise.resolve() };

export function testApp(readiness: Readiness = okReadiness, env: Record<string, string> = {}) {
  const logs = new LogCapture();
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info', ...env });
  const app = buildApp({ config, readiness, logStream: logs });
  return { app, logs };
}
