// The one outbound HTTP client (FR-HUB-5, T11). Every request to a provider or
// a custom integration goes through here; a lint rule forbids raw HTTP
// elsewhere. https only, port 443 unless documented, every resolved address
// checked, the connection pinned to the checked address (no second lookup,
// so DNS rebinding cannot swap it), at most 3 redirects each re-checked,
// bounded time and response size.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isBlockedAddress } from './address.ts';

export { embeddedIpv4, ipv6Bytes, isBlockedAddress } from './address.ts';

export class OutboundError extends Error {
  readonly code:
    | 'INVALID_URL'
    | 'SCHEME_NOT_ALLOWED'
    | 'PORT_NOT_ALLOWED'
    | 'CREDENTIALS_IN_URL'
    | 'BLOCKED_ADDRESS'
    | 'DNS_FAILED'
    | 'TOO_MANY_REDIRECTS'
    | 'TIMEOUT'
    | 'RESPONSE_TOO_LARGE'
    | 'NETWORK_ERROR';

  constructor(code: OutboundError['code'], message: string) {
    super(message);
    this.name = 'OutboundError';
    this.code = code;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** What the transport is asked to do: connect to `address` (already checked) but speak to `hostname`. */
export interface TransportRequest {
  readonly address: string;
  readonly family: 4 | 6;
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | null;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}
export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface OutboundOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer | null;
  /** Default 15 s (FR-HUB-2). */
  readonly timeoutMs?: number;
  /** Default 5 MB. */
  readonly maxBytes?: number;
  /** Ports other than 443 a provider documents. */
  readonly allowedPorts?: readonly number[];
  readonly maxRedirects?: number;
  /** For tests: DNS and the network. */
  readonly resolver?: Resolver;
  readonly transport?: Transport;
}

export interface OutboundResponse extends TransportResponse {
  /** The final URL after redirects. */
  readonly url: string;
}

const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, order: 'verbatim' })).map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));

/** Node https with the lookup pinned to the checked address; TLS still verifies `hostname`. */
const httpsTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const r = httpsRequest(
      {
        host: req.hostname,
        servername: isIP(req.hostname) ? undefined : req.hostname,
        port: req.port,
        path: req.path,
        method: req.method,
        headers: req.headers,
        // Never resolve again: answer every lookup with the address that was checked.
        lookup: (_host, options, cb) => {
          if ((options as { all?: boolean }).all) cb(null, [{ address: req.address, family: req.family }]);
          else cb(null, req.address, req.family);
        },
        timeout: req.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > req.maxBytes) {
            r.destroy(new OutboundError('RESPONSE_TOO_LARGE', 'The response is too large.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new OutboundError('TIMEOUT', 'The provider did not answer in time.')));
    r.on('error', (err) => {
      reject(
        err instanceof OutboundError ? err : new OutboundError('NETWORK_ERROR', 'The provider could not be reached.'),
      );
    });
    if (req.body) r.write(req.body);
    r.end();
  });

/** Checks a URL and resolves its host; throws unless every address is allowed. */
export async function checkTarget(
  raw: string,
  opts: Pick<OutboundOptions, 'allowedPorts' | 'resolver'> = {},
): Promise<{ url: URL; addresses: readonly ResolvedAddress[] }> {
  let url: URL;
  try {
    // The WHATWG parser normalises decimal, octal, hex and short IPv4 forms (e.g. 0x7f.1 → 127.0.0.1).
    url = new URL(raw);
  } catch {
    throw new OutboundError('INVALID_URL', 'The address is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new OutboundError('SCHEME_NOT_ALLOWED', 'Only https addresses are allowed.');
  if (url.username || url.password) {
    throw new OutboundError('CREDENTIALS_IN_URL', 'Credentials must not be part of the address.');
  }
  const port = url.port === '' ? 443 : Number(url.port);
  if (port !== 443 && !(opts.allowedPorts ?? []).includes(port)) {
    throw new OutboundError('PORT_NOT_ALLOWED', 'Only port 443 is allowed for this integration.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly ResolvedAddress[];
  const literal = isIP(host);
  if (literal !== 0) addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  else {
    try {
      addresses = await (opts.resolver ?? systemResolver)(host);
    } catch {
      throw new OutboundError('DNS_FAILED', 'The host name could not be resolved.');
    }
  }
  if (addresses.length === 0) throw new OutboundError('DNS_FAILED', 'The host name could not be resolved.');
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    throw new OutboundError('BLOCKED_ADDRESS', 'This address is not allowed (private, local or reserved network).');
  }
  return { url, addresses };
}

/** Sends one request through the guard; follows up to 3 redirects, re-checking each. */
export async function guardedRequest(raw: string, opts: OutboundOptions = {}): Promise<OutboundResponse> {
  const transport = opts.transport ?? httpsTransport;
  const maxRedirects = opts.maxRedirects ?? 3;
  let method = (opts.method ?? 'GET').toUpperCase();
  let body = opts.body === undefined || opts.body === null ? null : Buffer.from(opts.body);
  let current = raw;
  for (let hop = 0; ; hop++) {
    const { url, addresses } = await checkTarget(current, opts);
    const target = addresses[0];
    if (!target) throw new OutboundError('DNS_FAILED', 'The host name could not be resolved.');
    const res = await transport({
      address: target.address,
      family: target.family,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port === '' ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...(opts.headers ?? {}), host: url.host },
      body,
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBytes: opts.maxBytes ?? 5 * 1024 * 1024,
    });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && typeof location === 'string') {
      if (hop >= maxRedirects) throw new OutboundError('TOO_MANY_REDIRECTS', 'The provider redirected too many times.');
      current = new URL(location, url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
      }
      continue;
    }
    return { ...res, url: url.toString() };
  }
}
