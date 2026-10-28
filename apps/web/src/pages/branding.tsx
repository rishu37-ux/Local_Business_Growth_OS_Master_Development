// Branding and online store (increments 11.1 and 11.4, D-069): the shop's
// logo and colour for its invoices and website, and the website's address.
// The dashboard itself looks the same for every shop.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api, uploadFile } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Badge, Button, Checkbox, errorText, Field, Page } from '../ui.tsx';

interface Branding {
  hasLogo: boolean;
  brandColor: string | null;
  storeSlug: string | null;
  storeEnabled: boolean;
  storeTagline: string | null;
  storePath: string | null;
}

export function BrandingPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}/branding`;
  const branding = useQuery({ queryKey: ['branding', businessId], queryFn: () => api<{ branding: Branding }>(base) });
  const b = branding.data?.branding;
  const canManage = business.can('business.settings.manage');
  const [file, setFile] = useState<File | null>(null);
  const [color, setColor] = useState('');
  const [slug, setSlug] = useState('');
  const [tagline, setTagline] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  useEffect(() => {
    if (!b) return;
    setColor(b.brandColor ?? '');
    setSlug(b.storeSlug ?? '');
    setTagline(b.storeTagline ?? '');
    setEnabled(b.storeEnabled);
  }, [b]);
  const done = async (text: string) => {
    setNotice({ text, tone: 'success' });
    await queryClient.invalidateQueries({ queryKey: ['branding', businessId] });
  };
  const failed = (err: unknown) => {
    setNotice({ text: errorText(err), tone: 'error' });
  };
  return (
    <Page
      eyebrow="Settings"
      title="Branding and online store"
      description="Your logo and colour appear on invoices issued from now on and on your shop's website. The website is separate from this dashboard."
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      <section aria-labelledby="logo-heading">
        <h2 id="logo-heading" className="section-title">
          Logo
        </h2>
        {b?.hasLogo ? (
          <img
            src={`${base}/logo?v=${String(branding.dataUpdatedAt)}`}
            alt="Current logo"
            className="mb-3 max-h-20 max-w-60 rounded border border-ink-200 bg-white object-contain p-1"
          />
        ) : (
          <p className="mb-3 text-sm text-ink-600">No logo yet.</p>
        )}
        {canManage ? (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              if (!file) return;
              setNotice(null);
              uploadFile(base + '/logo', file)
                .then(() => done('Logo saved. Invoices issued from now on show it.'))
                .catch(failed);
            }}
          >
            <div className="mb-3 flex flex-col gap-1">
              <label htmlFor="logo-file" className="text-sm font-medium text-ink-800">
                Logo file (PNG or JPEG, up to 1 MB and 2000 × 2000 pixels)
              </label>
              <input
                id="logo-file"
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                }}
                className="max-w-full text-sm"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="secondary" isDisabled={!file}>
                Upload logo
              </Button>
              {b?.hasLogo ? (
                <Button
                  variant="secondary"
                  onPress={() => {
                    setNotice(null);
                    api(base + '/logo', { method: 'DELETE' })
                      .then(() => done('Logo removed. Invoices already issued keep theirs.'))
                      .catch(failed);
                  }}
                >
                  Remove logo
                </Button>
              ) : null}
            </div>
          </Form>
        ) : null}
      </section>
      <section aria-labelledby="store-heading">
        <h2 id="store-heading" className="section-title">
          Colour and online store
        </h2>
        {b?.storePath && b.storeEnabled ? (
          <p className="mb-3 text-sm">
            <Badge tone="success">Online</Badge>{' '}
            <a className="link" href={b.storePath} target="_blank" rel="noreferrer">
              Open your shop&apos;s website<span className="sr-only"> (opens in a new tab)</span>
            </a>{' '}
            <span className="text-ink-600">{`${window.location.origin}${b.storePath}`}</span>
          </p>
        ) : (
          <p className="mb-3 text-sm text-ink-600">Your website is off.</p>
        )}
        {canManage ? (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              setNotice(null);
              api(base, {
                method: 'PUT',
                body: {
                  brandColor: color.trim() === '' ? null : color.trim(),
                  storeSlug: slug.trim() === '' ? null : slug.trim(),
                  storeTagline: tagline.trim() === '' ? null : tagline.trim(),
                  storeEnabled: enabled,
                },
              })
                .then(() => done('Saved.'))
                .catch(failed);
            }}
          >
            <Field
              label="Brand colour (e.g. #0a7a55)"
              name="brandColor"
              value={color}
              onChange={setColor}
              isRequired={false}
              description="Used for accent lines on invoices and the website header."
            />
            <Field
              label="Website address (3–40 letters, digits or hyphens)"
              name="storeSlug"
              value={slug}
              onChange={setSlug}
              isRequired={false}
              {...(slug ? { description: `Your website: ${window.location.origin}/s/${slug.toLowerCase()}` } : {})}
            />
            <Field
              label="Short line under your name (optional)"
              name="storeTagline"
              value={tagline}
              onChange={setTagline}
              isRequired={false}
            />
            <Checkbox
              label="Show my website (only products published to the website appear; see Online selling)"
              name="storeEnabled"
              checked={enabled}
              onChange={setEnabled}
            />
            <Button type="submit">Save</Button>
          </Form>
        ) : null}
      </section>
    </Page>
  );
}
