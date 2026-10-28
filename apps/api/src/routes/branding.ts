// Shop branding and online-store settings (increments 11.1 and 11.4: D-069).
// Every member sees the branding (the dashboard shows the logo); only
// business.settings.manage changes it. The logo upload is raw bytes
// (application/octet-stream), like scans and receipts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BrandingError, getBranding, logoFile, setLogo, updateBranding } from '@lbgos/modules/branding';
import { OcrError } from '@lbgos/modules/ocr';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const STATUS = {
  LOGO_INVALID: 422,
  SLUG_INVALID: 422,
  SLUG_TAKEN: 409,
  STORE_NEEDS_ADDRESS: 422,
} as const satisfies Record<BrandingError['code'], number>;

export function registerBrandingRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const fail = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        if (err instanceof BrandingError) return fail(request, reply, STATUS[err.code], err.code, err.message);
        if (err instanceof OcrError) return fail(request, reply, 422, err.code, err.message);
        throw err;
      }
    };
  const base = '/api/businesses/:businessId/branding';
  const view = async (request: FastifyRequest) => {
    const b = await getBranding(s.appDb, ctxOf(request));
    return {
      branding: {
        hasLogo: b.hasLogo,
        brandColor: b.brandColor,
        storeSlug: b.storeSlug,
        storeEnabled: b.storeEnabled,
        storeTagline: b.storeTagline,
        storePath: b.storeSlug ? `/s/${b.storeSlug}` : null,
      },
    };
  };

  app.get(base, { config: { permission: MEMBER }, schema: { params: businessParams } }, view);

  app.put(
    base,
    {
      config: { permission: 'business.settings.manage' },
      schema: {
        params: businessParams,
        body: z.strictObject({
          brandColor: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .nullable()
            .optional(),
          storeSlug: z.string().trim().max(40).nullable().optional(),
          storeEnabled: z.boolean().optional(),
          storeTagline: z.string().trim().max(120).nullable().optional(),
        }),
      },
    },
    guarded(async (request) => {
      await updateBranding(s.appDb, ctxOf(request), request.body as Parameters<typeof updateBranding>[2], request.id);
      return view(request);
    }),
  );

  const ocr = s.ocr;
  if (!ocr) return;

  app.get(
    `${base}/logo`,
    { config: { permission: MEMBER }, schema: { params: businessParams } },
    async (request, reply) => {
      const file = await logoFile(s.appDb, ocr, ctxOf(request));
      if (!file) return fail(request, reply, 404, 'NOT_FOUND', 'Not found.');
      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', 'inline')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(file.bytes));
    },
  );

  app.post(
    `${base}/logo`,
    {
      config: { permission: 'business.settings.manage' },
      bodyLimit: 1024 * 1024 + 1024,
      schema: { params: businessParams, body: z.instanceof(Buffer) },
    },
    guarded(async (request) => {
      await setLogo(s.appDb, ocr, ctxOf(request), request.body as Buffer, request.id);
      return view(request);
    }),
  );

  app.delete(
    `${base}/logo`,
    { config: { permission: 'business.settings.manage' }, schema: { params: businessParams } },
    guarded(async (request) => {
      await setLogo(s.appDb, ocr, ctxOf(request), null, request.id);
      return view(request);
    }),
  );
}
