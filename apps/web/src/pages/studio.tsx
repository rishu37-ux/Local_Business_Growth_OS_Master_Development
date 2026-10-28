// AI Creative Studio (increment 7.7 for FR-AIC-1…5): generate captions and
// images from catalogue facts and an approved offer through the tested AI
// integration, review the post-check flags, edit (a new version), and approve
// the exact version. The API enforces every rule; this screen explains them.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api, formatPaise } from '../api.ts';
import { useBusiness } from '../business.ts';
import {
  Alert,
  Badge,
  Button,
  cell,
  Checkbox,
  errorText,
  Field,
  humanize,
  NativeSelect,
  Page,
  statusTone,
  Table,
  TextArea,
} from '../ui.tsx';
import { discountText, type Offer } from './offers.tsx';

interface Flag {
  kind: 'PRICE' | 'PERCENT' | 'DATE' | 'SPEC' | 'LENGTH';
  text: string;
  acknowledgedBy: string | null;
}
export interface Draft {
  id: string;
  kind: 'CAPTION' | 'IMAGE';
  platform: string;
  aspect: string | null;
  body: string | null;
  uploadId: string | null;
  offerId: string | null;
  flags: Flag[];
  version: number;
  contentSha256: string;
  status: string;
  approvedSha256: string | null;
  createdAt: string;
}
interface ProductSummary {
  id: string;
  modelName: string;
  brandName: string | null;
}
interface Variant {
  id: string;
  sku: string;
  ram: string | null;
  storage: string | null;
  colour: string | null;
  sellingPricePaise: number;
  status: string;
}

export const PLATFORMS = [
  ['WHATSAPP', 'WhatsApp', 1024],
  ['SMS', 'SMS', 160],
  ['INSTAGRAM', 'Instagram', 2200],
  ['FACEBOOK', 'Facebook', 5000],
  ['GOOGLE_BUSINESS', 'Google Business Profile', 1500],
  ['GENERIC', 'Other', 2000],
] as const;
const platformName = (p: string) => PLATFORMS.find(([k]) => k === p)?.[1] ?? p;
const limitOf = (p: string) => PLATFORMS.find(([k]) => k === p)?.[2] ?? 2000;
const FLAG_LABELS: Record<Flag['kind'], string> = {
  PRICE: 'Price not in the catalogue or offer',
  PERCENT: 'Percentage not in the offer',
  DATE: 'Date not in the offer',
  SPEC: 'Specification not in the catalogue',
  LENGTH: 'Too long for the platform',
};

export function StudioPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const today = new Date().toISOString().slice(0, 10);
  const offers = useQuery({
    queryKey: ['offers', businessId],
    queryFn: () => api<{ offers: Offer[] }>(`${base}/offers`),
  });
  const drafts = useQuery({
    queryKey: ['drafts', businessId],
    queryFn: () => api<{ drafts: Draft[] }>(`${base}/studio/drafts`),
  });
  const [search, setSearch] = useState('');
  const products = useQuery({
    queryKey: ['studio-products', businessId, search],
    queryFn: async () => {
      const list = await api<{ products: ProductSummary[] }>(`${base}/products?q=${encodeURIComponent(search.trim())}`);
      return Promise.all(
        list.products.slice(0, 5).map(async (p) => ({
          product: p,
          variants: (await api<{ product: { variants: Variant[] } }>(`${base}/products/${p.id}`)).product.variants,
        })),
      );
    },
    enabled: search.trim().length >= 2 && business.can('catalogue.view'),
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [offerId, setOfferId] = useState('');
  const [platform, setPlatform] = useState('WHATSAPP');
  const [tone, setTone] = useState('friendly');
  const [kind, setKind] = useState('CAPTION');
  const [aspect, setAspect] = useState('1:1');
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setNotice(null);
    try {
      await fn();
      setNotice({ text: ok, tone: 'success' });
      await queryClient.invalidateQueries();
      return true;
    } catch (err) {
      setNotice({ text: errorText(err), tone: 'error' });
      return false;
    }
  };
  const usable = (offers.data?.offers ?? []).filter((o) => o.status === 'APPROVED' && o.validTo >= today);
  const rows = (drafts.data?.drafts ?? []).filter((d) => d.status !== 'ARCHIVED');
  const current = rows.find((d) => d.id === open) ?? null;
  return (
    <Page
      eyebrow="Marketing"
      title="Creative Studio"
      description="Captions and images written from your catalogue and approved offers. Every price, percentage, date and specification is checked against those facts before anything can be approved."
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      {business.can('marketing.draft') ? (
        <section aria-labelledby="generate-heading">
          <h2 id="generate-heading" className="section-title">
            Generate
          </h2>
          <Field
            label="Find products (name, model or SKU)"
            name="studioSearch"
            value={search}
            onChange={setSearch}
            isRequired={false}
          />
          {(products.data ?? []).map(({ product, variants }) => (
            <fieldset key={product.id} className="mb-3">
              <legend className="mb-1 text-sm font-medium text-ink-800">
                {product.brandName ? `${product.brandName} ` : ''}
                {product.modelName}
              </legend>
              {variants
                .filter((v) => v.status === 'ACTIVE')
                .map((v) => (
                  <Checkbox
                    key={v.id}
                    name={`variant-${v.id}`}
                    label={`${[v.ram, v.storage, v.colour].filter(Boolean).join(' ') || v.sku} — ${formatPaise(v.sellingPricePaise)}`}
                    checked={picked.includes(v.id)}
                    onChange={(on) => {
                      setPicked(on ? [...picked, v.id].slice(0, 10) : picked.filter((x) => x !== v.id));
                    }}
                  />
                ))}
            </fieldset>
          ))}
          <p className="mb-3 text-sm text-ink-600">{String(picked.length)} selected (up to 10).</p>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api(`${base}/studio/generate`, {
                    method: 'POST',
                    body: {
                      kind,
                      productIds: picked,
                      offerId: offerId || null,
                      platform,
                      tone,
                      ...(kind === 'IMAGE' ? { aspect } : {}),
                    },
                  }),
                'Draft generated. Review it below.',
              );
            }}
          >
            <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
              <NativeSelect
                label="Make"
                name="studioKind"
                value={kind}
                onChange={setKind}
                options={[
                  ['CAPTION', 'Caption'],
                  ['IMAGE', 'Image'],
                ]}
              />
              <NativeSelect
                label="Offer"
                name="studioOffer"
                value={offerId}
                onChange={setOfferId}
                options={[['', 'No offer'], ...usable.map((o) => [o.id, `${o.title} (${discountText(o)})`] as const)]}
              />
              <NativeSelect
                label="Platform"
                name="studioPlatform"
                value={platform}
                onChange={setPlatform}
                options={PLATFORMS.map(([k, name]) => [k, name] as const)}
              />
              <NativeSelect
                label="Tone"
                name="studioTone"
                value={tone}
                onChange={setTone}
                options={[
                  ['friendly', 'Friendly'],
                  ['formal', 'Formal'],
                  ['festive', 'Festive'],
                ]}
              />
              {kind === 'IMAGE' ? (
                <NativeSelect
                  label="Shape"
                  name="studioAspect"
                  value={aspect}
                  onChange={setAspect}
                  options={[
                    ['1:1', 'Square 1:1'],
                    ['4:5', 'Portrait 4:5'],
                    ['9:16', 'Story 9:16'],
                    ['16:9', 'Wide 16:9'],
                  ]}
                />
              ) : null}
            </div>
            <Button type="submit" isDisabled={picked.length === 0}>
              Generate
            </Button>
          </Form>
        </section>
      ) : null}
      <section aria-labelledby="drafts-heading">
        <h2 id="drafts-heading" className="section-title">
          Drafts
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-600">No drafts yet.</p>
        ) : (
          <Table caption="Drafts" headers={['Created', 'Kind', 'Platform', 'Version', 'Status', 'Open flags', '']}>
            {rows.map((d) => (
              <tr key={d.id}>
                <td className={cell}>{new Date(d.createdAt).toLocaleString('en-IN')}</td>
                <td className={cell}>{humanize(d.kind)}</td>
                <td className={cell}>{platformName(d.platform)}</td>
                <td className={cell}>{String(d.version)}</td>
                <td className={cell}>
                  <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
                </td>
                <td className={cell}>{String(d.flags.filter((f) => f.acknowledgedBy === null).length)}</td>
                <td className={cell}>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setOpen(d.id === open ? null : d.id);
                    }}
                  >
                    {d.id === open ? 'Close draft' : `Open draft ${new Date(d.createdAt).toLocaleTimeString('en-IN')}`}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      {current ? (
        <DraftReview
          key={`${current.id}-${String(current.version)}`}
          base={base}
          draft={current}
          canDraft={business.can('marketing.draft')}
          canApprove={business.can('marketing.approve')}
          run={run}
        />
      ) : null}
    </Page>
  );
}

function DraftReview(props: {
  base: string;
  draft: Draft;
  canDraft: boolean;
  canApprove: boolean;
  run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;
}) {
  const d = props.draft;
  const url = `${props.base}/studio/drafts/${d.id}`;
  const [text, setText] = useState(d.body ?? '');
  const [ack, setAck] = useState<string[]>([]);
  const open = d.flags.filter((f) => f.acknowledgedBy === null);
  const limit = limitOf(d.platform);
  const approved = d.status === 'APPROVED' && d.approvedSha256 === d.contentSha256;
  return (
    <section aria-labelledby="review-heading">
      <h2 id="review-heading" className="section-title">
        Review draft
      </h2>
      <p className="mb-3 text-sm text-ink-700">
        {humanize(d.kind)} for {platformName(d.platform)} · version {String(d.version)} · content{' '}
        <span className="font-mono">{d.contentSha256.slice(0, 8)}</span> ·{' '}
        <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
        {approved ? ' — this exact version is approved.' : ''}
      </p>
      {d.kind === 'IMAGE' ? (
        <img
          src={`${url}/image`}
          alt={`Generated image, ${d.aspect ?? ''}`}
          className="mb-3 max-h-80 max-w-full rounded-lg border border-ink-200"
        />
      ) : (
        <>
          <TextArea
            label="Text"
            name="draftText"
            value={text}
            onChange={setText}
            rows={5}
            description={`${String(text.length)} of ${String(limit)} characters for ${platformName(d.platform)}. Saving a change makes a new version and clears any approval.`}
          />
          {props.canDraft && d.status !== 'ARCHIVED' ? (
            <div className="mb-4">
              <Button
                variant="secondary"
                isDisabled={text.trim() === (d.body ?? '').trim()}
                onPress={() => {
                  void props.run(
                    () => api(url, { method: 'PATCH', body: { body: text } }),
                    'Saved as a new version; it needs approval again.',
                  );
                }}
              >
                Save as new version
              </Button>
            </div>
          ) : null}
        </>
      )}
      <h3 className="mb-2 text-base font-semibold">Check against your facts</h3>
      {d.flags.length === 0 ? (
        <p className="mb-3 text-sm text-emerald-900">No price, percentage, date or specification outside your facts.</p>
      ) : (
        <ul className="mb-3 list-disc pl-5 text-sm">
          {d.flags.map((f) => (
            <li key={`${f.kind}-${f.text}`}>
              {FLAG_LABELS[f.kind]}: <strong>{f.text}</strong>
              {f.acknowledgedBy ? ' — accepted by an approver' : ''}
            </li>
          ))}
        </ul>
      )}
      {props.canApprove && open.some((f) => f.kind !== 'LENGTH') ? (
        <div className="mb-3">
          {open
            .filter((f) => f.kind !== 'LENGTH')
            .map((f) => (
              <Checkbox
                key={`ack-${f.text}`}
                name={`ack-${f.kind}-${f.text}`}
                label={`I checked "${f.text}" and it is correct`}
                checked={ack.includes(f.text)}
                onChange={(on) => {
                  setAck(on ? [...ack, f.text] : ack.filter((x) => x !== f.text));
                }}
              />
            ))}
          <Button
            variant="secondary"
            isDisabled={ack.length === 0}
            onPress={() => {
              void props.run(
                () => api(`${url}/acknowledge`, { method: 'POST', body: { values: ack } }),
                'Checked values accepted.',
              );
            }}
          >
            Accept checked values
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {props.canDraft && d.status === 'DRAFT' ? (
          <Button
            onPress={() => {
              void props.run(() => api(`${url}/submit`, { method: 'POST' }), 'Sent for approval.');
            }}
          >
            Send for approval
          </Button>
        ) : null}
        {props.canApprove && d.status === 'PENDING_APPROVAL' ? (
          <>
            <Button
              onPress={() => {
                void props.run(
                  () => api(`${url}/approve`, { method: 'POST' }),
                  'Approved: this exact version may be used.',
                );
              }}
            >
              Approve this version
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                void props.run(() => api(`${url}/reject`, { method: 'POST' }), 'Rejected.');
              }}
            >
              Reject
            </Button>
          </>
        ) : null}
        {props.canDraft && d.status !== 'ARCHIVED' ? (
          <Button
            variant="secondary"
            onPress={() => {
              void props.run(() => api(`${url}/archive`, { method: 'POST' }), 'Archived.');
            }}
          >
            Archive
          </Button>
        ) : null}
      </div>
    </section>
  );
}
