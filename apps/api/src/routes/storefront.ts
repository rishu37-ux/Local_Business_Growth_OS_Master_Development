// The shop's public website (increment 11.4, D-069): separate from the
// dashboard, server-rendered HTML with no scripts. It has no session and no
// tenant context. The store address is resolved, and the public fields of
// published website listings are read, only through definer functions
// (migration 0032). Order requests go through the commerce module as the
// system actor. Every value is escaped; the CSP allows only this site's own
// stylesheets, images and form posts.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { SYSTEM_ACTOR } from '@lbgos/db';
import { CommerceError, createWebsiteOrder } from '@lbgos/modules/commerce';
import { getUploadFile } from '@lbgos/modules/ocr';
import type { AppServices } from '../services.ts';

const STORE_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const slugParam = z.strictObject({ slug: z.string().regex(/^[a-z0-9-]{3,40}$/) });
const productParams = z.strictObject({ slug: z.string().regex(/^[a-z0-9-]{3,40}$/), listingId: z.uuid() });
/** Order requests per source address and hour (spam and stock-hoarding protection). */
export const STORE_ORDERS_PER_HOUR = 10;

interface Profile {
  business_id: string;
  name: string;
  address: string | null;
  phone: string | null;
  brand_color: string | null;
  tagline: string | null;
  logo_upload_id: string | null;
  website_channel_id: string | null;
}
interface StoreListing {
  listing_id: string;
  product_name: string;
  brand: string | null;
  variant_label: string | null;
  price_paise: string;
  available: number;
}

const esc = (v: string | number | null | undefined): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const money = (paise: number) => `₹${inr.format(paise / 100)}`;
const availability = (n: number) => (n <= 0 ? 'Out of stock' : n <= 3 ? `Only ${String(n)} left` : 'In stock');

/** Relative luminance (WCAG) of #rrggbb. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** The brand colour as header background, with whichever text colour contrasts more (WCAG AA ≥ 4.5 where possible). */
export function headerColours(brand: string | null): { bg: string; fg: string } {
  const bg = brand && /^#[0-9a-f]{6}$/.test(brand) ? brand : '#302b86';
  const l = luminance(bg);
  return { bg, fg: contrast(l, 1) >= contrast(l, luminance('#111827')) ? '#ffffff' : '#111827' };
}

const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans',sans-serif;color:#151a2d;background:#f6f7fb;line-height:1.45}
a{color:#3b34a8}
.wrap{max-width:64rem;margin:0 auto;padding:0 16px}
header.top{padding:20px 0}
header.top .wrap{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header.top img{max-height:56px;max-width:160px;object-fit:contain;background:#fff;border-radius:8px;padding:4px}
header.top h1{margin:0;font-size:1.5rem}
header.top p{margin:2px 0 0}
main{padding:24px 0 40px}
.grid{list-style:none;margin:0;padding:0;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))}
.card{background:#fff;border:1px solid #d9dde9;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:6px}
.card h2,.card h3{margin:0;font-size:1.05rem}
.price{font-weight:700;font-size:1.15rem}
.muted{color:#47506c}
.ok{color:#11603c;font-weight:600}
.low{color:#8a4b00;font-weight:600}
.out{color:#9b1c1c;font-weight:600}
form{display:flex;flex-direction:column;gap:12px;max-width:26rem}
label{display:flex;flex-direction:column;gap:4px;font-weight:600}
fieldset{display:flex;flex-direction:column;gap:12px;border:1px solid #d4d4d8;border-radius:8px;padding:12px;margin:0}legend{font-weight:600;padding:0 4px}
input{font:inherit;padding:10px 12px;border:1px solid #8a93ad;border-radius:8px}
input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #3b34a8;outline-offset:2px}
button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:8px;background:#302b86;color:#fff;cursor:pointer}
.trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.notice{background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:10px 12px}
.error{background:#fdecec;border:1px solid #f5b5b5;border-radius:8px;padding:10px 12px}
footer{border-top:1px solid #d9dde9;padding:16px 0;font-size:.9rem}
`;

export function registerStorefrontRoutes(app: FastifyInstance, s: AppServices): void {
  const profileOf = async (slug: string): Promise<Profile | null> =>
    (await sql<Profile>`select * from lbg.store_profile(${slug})`.execute(s.appDb)).rows[0] ?? null;
  const listingsOf = async (slug: string): Promise<StoreListing[]> =>
    (await sql<StoreListing>`select * from lbg.store_listings(${slug})`.execute(s.appDb)).rows;

  const send = (reply: FastifyReply, status: number, html: string) =>
    reply
      .status(status)
      .header('content-security-policy', STORE_CSP)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(html);

  const page = (p: Profile, slug: string, title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/s/assets/store.css"><link rel="stylesheet" href="/s/${esc(slug)}/theme.css"></head>
<body><header class="top"><div class="wrap">${p.logo_upload_id ? `<img src="/s/${esc(slug)}/logo" alt="${esc(p.name)} logo">` : ''}
<div><h1><a class="home" href="/s/${esc(slug)}">${esc(p.name)}</a></h1>${p.tagline ? `<p>${esc(p.tagline)}</p>` : ''}</div></div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap">${esc(p.name)}${p.address ? ` · ${esc(p.address).replace(/\n/g, ', ')}` : ''}${p.phone ? ` · <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ''}</div></footer>
</body></html>`;

  const notFound = (reply: FastifyReply) =>
    send(
      reply,
      404,
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><main><h1>This shop page does not exist.</h1></main></body></html>',
    );

  app.get('/s/assets/store.css', { config: { public: true } }, (_request, reply) =>
    reply.type('text/css; charset=utf-8').header('cache-control', 'public, max-age=3600').send(BASE_CSS),
  );

  app.get('/s/:slug/theme.css', { config: { public: true }, schema: { params: slugParam } }, async (request, reply) => {
    const p = await profileOf((request.params as { slug: string }).slug);
    const { bg, fg } = headerColours(p?.brand_color ?? null);
    return reply
      .type('text/css; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        `header.top{background:${bg};color:${fg}}header.top a.home{color:${fg};text-decoration:none}header.top a:focus-visible{outline-color:${fg}}`,
      );
  });

  app.get('/s/:slug/logo', { config: { public: true }, schema: { params: slugParam } }, async (request, reply) => {
    const p = await profileOf((request.params as { slug: string }).slug);
    const file =
      p?.logo_upload_id && s.ocr
        ? await getUploadFile(s.appDb, s.ocr, { businessId: p.business_id, userId: SYSTEM_ACTOR }, p.logo_upload_id)
        : null;
    if (!file) return notFound(reply);
    return reply
      .header('content-type', file.contentType)
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'public, max-age=300')
      .send(Buffer.from(file.bytes));
  });

  app.get('/s/:slug', { config: { public: true }, schema: { params: slugParam } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const p = await profileOf(slug);
    if (!p) return notFound(reply);
    const items = await listingsOf(slug);
    const cards = items
      .map(
        (l) => `<li class="card"><h2><a href="/s/${esc(slug)}/p/${esc(l.listing_id)}">${esc(l.product_name)}</a></h2>
${l.brand ? `<div class="muted">${esc(l.brand)}</div>` : ''}${l.variant_label ? `<div>${esc(l.variant_label)}</div>` : ''}
<div class="price">${money(Number(l.price_paise))}</div><div class="${l.available <= 0 ? 'out' : l.available <= 3 ? 'low' : 'ok'}">${availability(l.available)}</div></li>`,
      )
      .join('');
    return send(
      reply,
      200,
      page(
        p,
        slug,
        p.name,
        `<h2>Products</h2>${items.length === 0 ? '<p>No products are listed yet.</p>' : `<ul class="grid">${cards}</ul>`}`,
      ),
    );
  });

  const productPage = (
    p: Profile,
    slug: string,
    l: StoreListing,
    message: { tone: 'notice' | 'error'; text: string } | null,
  ) => {
    const form =
      l.available > 0
        ? `<h3>Ask the shop to keep it for you</h3>
<p class="muted">No payment online. ${esc(p.name)} receives your name and number (and your email and address, if you give them) to contact you about this order, and you pay the shop.</p>
<form method="post" action="/s/${esc(slug)}/p/${esc(l.listing_id)}/order">
<input type="hidden" name="token" value="${randomBytes(16).toString('hex')}">
<label>Your name <input name="name" required maxlength="120" autocomplete="name"></label>
<label>Mobile number <input name="mobile" required inputmode="tel" maxlength="16" autocomplete="tel"></label>
<label>Quantity <input name="quantity" type="number" min="1" max="${String(Math.min(10, l.available))}" value="1" required></label>
<label>Email (optional) <input name="email" type="email" maxlength="254" autocomplete="email"></label>
<fieldset><legend>Delivery address (optional, if you want it delivered)</legend>
<label>Address <input name="address" maxlength="200" autocomplete="street-address"></label>
<label>City <input name="city" maxlength="80" autocomplete="address-level2"></label>
<label>PIN code <input name="pincode" inputmode="numeric" maxlength="6" autocomplete="postal-code"></label>
</fieldset>
<div class="trap" aria-hidden="true"><label>Leave empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
<button type="submit">Send order request</button></form>`
        : '<p>This item is out of stock right now. Please check again later or call the shop.</p>';
    return page(
      p,
      slug,
      `${l.product_name} · ${p.name}`,
      `${message ? `<p class="${message.tone}" role="${message.tone === 'error' ? 'alert' : 'status'}">${esc(message.text)}</p>` : ''}
<div class="card"><h2>${esc(l.product_name)}</h2>${l.brand ? `<div class="muted">${esc(l.brand)}</div>` : ''}
${l.variant_label ? `<div>${esc(l.variant_label)}</div>` : ''}<div class="price">${money(Number(l.price_paise))}</div>
<div class="${l.available <= 0 ? 'out' : l.available <= 3 ? 'low' : 'ok'}">${availability(l.available)}</div></div>
${form}<p><a href="/s/${esc(slug)}">All products</a></p>`,
    );
  };

  const findListing = async (slug: string, listingId: string) => {
    const p = await profileOf(slug);
    const l = p ? (await listingsOf(slug)).find((x) => x.listing_id === listingId) : undefined;
    return p && l ? { p, l } : null;
  };

  app.get(
    '/s/:slug/p/:listingId',
    { config: { public: true }, schema: { params: productParams } },
    async (request, reply) => {
      const { slug, listingId } = request.params as z.infer<typeof productParams>;
      const found = await findListing(slug, listingId);
      if (!found) return notFound(reply);
      return send(reply, 200, productPage(found.p, slug, found.l, null));
    },
  );

  // Order requests: form posts only, a small body, a per-address hourly limit.
  const counts = new Map<string, number>();
  let windowStart = 0;
  const allow = (ip: string) => {
    const now = Date.now();
    if (now - windowStart >= 3_600_000) {
      windowStart = now;
      counts.clear();
    }
    const n = (counts.get(ip) ?? 0) + 1;
    counts.set(ip, n);
    return n <= STORE_ORDERS_PER_HOUR;
  };
  const orderBody = z.object({
    token: z.string().regex(/^[0-9a-f]{32}$/),
    name: z.string().trim().min(1).max(120),
    mobile: z.string().trim().min(10).max(16),
    quantity: z.coerce.number().int().min(1).max(10),
    email: z.string().trim().max(254).optional(),
    address: z.string().trim().max(200).optional(),
    city: z.string().trim().max(80).optional(),
    pincode: z.string().trim().max(10).optional(),
    website: z.string().max(200).optional(),
  });
  const ORDER_FORM_ERRORS: Partial<Record<CommerceError['code'], string>> = {
    MOBILE_INVALID: 'Enter a 10-digit Indian mobile number.',
    EMAIL_INVALID: 'Please check the email address.',
    PINCODE_INVALID: 'Enter a 6-digit PIN code.',
  };

  void app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_req, body, next) => {
        next(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );
    scope.post(
      '/s/:slug/p/:listingId/order',
      { config: { public: true }, schema: { params: productParams } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { slug, listingId } = request.params as z.infer<typeof productParams>;
        const found = await findListing(slug, listingId);
        if (!found) return notFound(reply);
        const { p, l } = found;
        if (!allow(request.ip)) {
          request.log.warn('security: store order rate limit reached');
          return send(
            reply.header('retry-after', '3600'),
            429,
            productPage(p, slug, l, {
              tone: 'error',
              text: 'Too many requests from your connection. Please call the shop.',
            }),
          );
        }
        const parsed = orderBody.safeParse(request.body);
        if (!parsed.success || (parsed.data.website ?? '') !== '') {
          return send(
            reply,
            400,
            productPage(p, slug, l, { tone: 'error', text: 'Please check your name, mobile number and quantity.' }),
          );
        }
        const { address = '', city = '', pincode = '', email = '' } = parsed.data;
        const anyAddress = address !== '' || city !== '' || pincode !== '';
        if (anyAddress && (address === '' || city === '' || pincode === '')) {
          return send(
            reply,
            400,
            productPage(p, slug, l, { tone: 'error', text: 'For delivery, enter the address, city and PIN code.' }),
          );
        }
        try {
          await createWebsiteOrder(
            s.appDb,
            { businessId: p.business_id, userId: SYSTEM_ACTOR },
            {
              listingId,
              quantity: parsed.data.quantity,
              name: parsed.data.name,
              mobile: parsed.data.mobile,
              token: parsed.data.token,
              ...(email === '' ? {} : { email }),
              ...(anyAddress ? { address: { line1: address, city, pincode } } : {}),
            },
          );
        } catch (err) {
          const formError = err instanceof CommerceError ? ORDER_FORM_ERRORS[err.code] : undefined;
          if (err instanceof CommerceError && (err.code === 'NOT_ENOUGH_STOCK' || formError)) {
            const text = formError ?? `Only ${String(err.available ?? 0)} available right now.`;
            const fresh = (await findListing(slug, listingId))?.l ?? l;
            return send(reply, formError ? 400 : 409, productPage(p, slug, fresh, { tone: 'error', text }));
          }
          if (err instanceof CommerceError && err.code === 'NOT_FOUND') return notFound(reply);
          throw err;
        }
        return send(
          reply,
          200,
          page(
            p,
            slug,
            `Order request sent · ${p.name}`,
            `<p class="notice" role="status">Thank you. ${esc(p.name)} has your request for ${String(parsed.data.quantity)} × ${esc(l.product_name)} and will contact you. The item is kept for you until the shop confirms.</p><p><a href="/s/${esc(slug)}">All products</a></p>`,
          ),
        );
      },
    );
    done();
  });
}
