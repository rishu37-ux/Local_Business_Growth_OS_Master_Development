// Private file storage behind an adapter (ADR-11, FR-OCR-6 AC2). Keys are
// random, prefixed by business ID, and never derived from user input. An
// S3-compatible adapter is added when hosting is chosen (Q2).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StorageAdapter {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

function checkKey(key: string): void {
  if (!KEY.test(key)) throw new Error('invalid storage key');
}

/** In-memory storage for tests and API-only runs. */
export class MemoryStorage implements StorageAdapter {
  readonly #files = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): Promise<void> {
    checkKey(key);
    if (this.#files.has(key)) return Promise.reject(new Error('key exists'));
    this.#files.set(key, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array> {
    checkKey(key);
    const bytes = this.#files.get(key);
    return bytes ? Promise.resolve(Uint8Array.from(bytes)) : Promise.reject(new Error('not found'));
  }

  get size(): number {
    return this.#files.size;
  }
}

/**
 * Files under a private directory (development and single-host pilots). Files
 * are written once (`wx`), readable by the service user only (0600).
 */
export class LocalFileStorage implements StorageAdapter {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  #path(key: string): string {
    checkKey(key);
    const full = path.resolve(this.#root, key);
    if (!full.startsWith(this.#root + path.sep)) throw new Error('invalid storage key');
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const full = this.#path(key);
    await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, bytes, { flag: 'wx', mode: 0o600 });
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.#path(key)));
  }
}
