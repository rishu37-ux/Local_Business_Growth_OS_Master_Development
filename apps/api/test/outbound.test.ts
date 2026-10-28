// Increment 7.1: the guarded outbound HTTP client (FR-HUB-5, T11). No real
// network: DNS and the transport are injected; one test uses the real https
// transport against a refused address only to check it never connects.
import {
  checkTarget,
  embeddedIpv4,
  guardedRequest,
  ipv6Bytes,
  isBlockedAddress,
  OutboundError,
  type ResolvedAddress,
  type Transport,
  type TransportRequest,
} from '@lbgos/modules/outbound';
import { describe, expect, it } from 'vitest';

const PUBLIC = '93.184.215.14'; // a public address (documentation ranges are blocked)
const dns =
  (map: Record<string, readonly ResolvedAddress[]>) =>
  (host: string): Promise<readonly ResolvedAddress[]> =>
    Promise.resolve(map[host] ?? []);
const ok = (seen: TransportRequest[] = []): Transport => {
  return (req) => {
    seen.push(req);
    return Promise.resolve({ status: 200, headers: {}, body: Buffer.from('ok') });
  };
};
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (err) {
    return err instanceof OutboundError ? err.code : String(err);
  }
};

describe('blocked address ranges (FR-HUB-5 AC3)', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.8.9.10',
    '169.254.169.254', // cloud metadata
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.2.10',
    '198.18.0.1',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1', // IPv4-mapped
    '::ffff:7f00:1', // mapped, hex form
    '::ffff:169.254.169.254',
    '::127.0.0.1', // IPv4-compatible
    '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
    '2002:a9fe:a9fe::1', // 6to4 of 169.254.169.254
    '2002:c0a8:0101::1', // 6to4 of 192.168.1.1
    'localhost', // not an IP literal
    '',
  ])('%s is blocked', (a) => {
    expect(isBlockedAddress(a)).toBe(true);
  });

  it.each([PUBLIC, '8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '%s is allowed',
    (a) => {
      expect(isBlockedAddress(a)).toBe(false);
    },
  );

  it('parses IPv6 forms and finds embedded IPv4', () => {
    expect(ipv6Bytes('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Bytes('::ffff:1.2.3.4').slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(embeddedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIpv4('2002:0a00:0001::')).toBe('10.0.0.1');
    expect(embeddedIpv4('2606:4700::1')).toBeNull();
  });
});

describe('URL checks (FR-HUB-5 AC2–3)', () => {
  it.each([
    ['https://127.0.0.1/', 'BLOCKED_ADDRESS'],
    ['https://2130706433/', 'BLOCKED_ADDRESS'], // decimal 127.0.0.1
    ['https://0x7f.0.0.1/', 'BLOCKED_ADDRESS'], // hex
    ['https://0177.0.0.1/', 'BLOCKED_ADDRESS'], // octal
    ['https://127.1/', 'BLOCKED_ADDRESS'], // short form
    ['https://0xa9fea9fe/', 'BLOCKED_ADDRESS'], // hex metadata address
    ['https://[::1]/', 'BLOCKED_ADDRESS'],
    ['https://[::ffff:169.254.169.254]/', 'BLOCKED_ADDRESS'],
    ['https://[fd00::abcd]/', 'BLOCKED_ADDRESS'],
    ['http://api.example.test/', 'SCHEME_NOT_ALLOWED'],
    ['ftp://api.example.test/', 'SCHEME_NOT_ALLOWED'],
    ['file:///etc/passwd', 'SCHEME_NOT_ALLOWED'],
    ['https://api.example.test:8443/', 'PORT_NOT_ALLOWED'],
    ['https://user:pass@api.example.test/', 'CREDENTIALS_IN_URL'],
    ['not a url', 'INVALID_URL'],
  ])('%s → %s', async (url, code) => {
    expect(
      await codeOf(checkTarget(url, { resolver: dns({ 'api.example.test': [{ address: PUBLIC, family: 4 }] }) })),
    ).toBe(code);
  });

  it('a name resolving to any private address is refused, even if another answer is public', async () => {
    const resolver = dns({
      'internal.example.test': [{ address: '10.0.0.5', family: 4 }],
      'mixed.example.test': [
        { address: PUBLIC, family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      'v6.example.test': [{ address: 'fe80::1', family: 6 }],
    });
    for (const host of ['internal', 'mixed', 'v6']) {
      expect(await codeOf(checkTarget(`https://${host}.example.test/`, { resolver }))).toBe('BLOCKED_ADDRESS');
    }
    expect(await codeOf(checkTarget('https://nowhere.example.test/', { resolver }))).toBe('DNS_FAILED');
  });

  it('a documented provider port can be allowed explicitly', async () => {
    const resolver = dns({ 'api.example.test': [{ address: PUBLIC, family: 4 }] });
    expect(await codeOf(checkTarget('https://api.example.test:8443/', { resolver, allowedPorts: [8443] }))).toBe('OK');
  });
});

describe('requests (FR-HUB-5 AC3–4)', () => {
  it('connects to the checked address and sends the host name for TLS and Host', async () => {
    const seen: TransportRequest[] = [];
    const res = await guardedRequest('https://api.example.test/v1/ping?x=1', {
      resolver: dns({ 'api.example.test': [{ address: PUBLIC, family: 4 }] }),
      transport: ok(seen),
      method: 'post',
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(seen.map((r) => [r.address, r.hostname, r.port, r.path, r.method, r.headers.host, r.timeoutMs])).toEqual([
      [PUBLIC, 'api.example.test', 443, '/v1/ping?x=1', 'POST', 'api.example.test', 15_000],
    ]);
  });

  it('DNS rebinding: the name is resolved once per hop and the connection uses that answer', async () => {
    let calls = 0;
    const resolver = (): Promise<readonly ResolvedAddress[]> => {
      calls++;
      // First answer public; any later lookup would say metadata.
      return Promise.resolve([{ address: calls === 1 ? PUBLIC : '169.254.169.254', family: 4 }]);
    };
    const seen: TransportRequest[] = [];
    await guardedRequest('https://rebind.example.test/', { resolver, transport: ok(seen) });
    expect(calls).toBe(1);
    expect(seen[0]?.address).toBe(PUBLIC);
  });

  it('follows at most 3 redirects and re-checks each target', async () => {
    const resolver = dns({ 'a.example.test': [{ address: PUBLIC, family: 4 }] });
    const toPrivate: Transport = () =>
      Promise.resolve({ status: 302, headers: { location: 'https://10.0.0.1/admin' }, body: Buffer.alloc(0) });
    expect(await codeOf(guardedRequest('https://a.example.test/', { resolver, transport: toPrivate }))).toBe(
      'BLOCKED_ADDRESS',
    );
    const toHttp: Transport = () =>
      Promise.resolve({ status: 301, headers: { location: 'http://a.example.test/' }, body: Buffer.alloc(0) });
    expect(await codeOf(guardedRequest('https://a.example.test/', { resolver, transport: toHttp }))).toBe(
      'SCHEME_NOT_ALLOWED',
    );
    let hops = 0;
    const loop: Transport = () => {
      hops++;
      return Promise.resolve({ status: 307, headers: { location: `/next/${String(hops)}` }, body: Buffer.alloc(0) });
    };
    expect(await codeOf(guardedRequest('https://a.example.test/', { resolver, transport: loop }))).toBe(
      'TOO_MANY_REDIRECTS',
    );
    expect(hops).toBe(4); // the first request and 3 redirects
    let n = 0;
    const seen: TransportRequest[] = [];
    const twice: Transport = (req) => {
      seen.push(req);
      n++;
      return Promise.resolve(
        n < 3
          ? { status: 303, headers: { location: `/step/${String(n)}` }, body: Buffer.alloc(0) }
          : { status: 200, headers: {}, body: Buffer.from('done') },
      );
    };
    const res = await guardedRequest('https://a.example.test/start', {
      resolver,
      transport: twice,
      method: 'POST',
      body: 'x',
    });
    expect([res.status, res.url]).toEqual([200, 'https://a.example.test/step/2']);
    expect(seen.map((r) => r.method)).toEqual(['POST', 'GET', 'GET']); // 303 switches to GET
  });

  it('the real https transport refuses a blocked address before any connection', async () => {
    expect(await codeOf(guardedRequest('https://169.254.169.254/latest/meta-data/'))).toBe('BLOCKED_ADDRESS');
    expect(await codeOf(guardedRequest('https://[::1]:443/'))).toBe('BLOCKED_ADDRESS');
  });
});
