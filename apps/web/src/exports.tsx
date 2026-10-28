// "Export: CSV · Excel" for a section's list (Phase 14, D-073). Shown to
// members with reports.export; the API also checks the section's permission
// and records every export.
import { useBusiness } from './business.ts';

export function ExportLinks(props: {
  readonly businessId: string;
  /** The API's list name, e.g. "products". */
  readonly list: string;
  /** What is exported, e.g. "the catalogue". */
  readonly what: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}) {
  const business = useBusiness(props.businessId);
  if (!business.can('reports.export')) return null;
  const period = props.from && props.to ? `&from=${props.from}&to=${props.to}` : '';
  const href = (format: 'csv' | 'xlsx') =>
    `/api/businesses/${props.businessId}/exports/${props.list}?format=${format}${period}`;
  return (
    <p className="text-sm">
      <span className="text-ink-700">Export {props.what}: </span>
      <a className="link" href={href('csv')} download>
        CSV<span className="sr-only"> file of {props.what}</span>
      </a>
      <span aria-hidden="true"> · </span>
      <a className="link" href={href('xlsx')} download>
        Excel<span className="sr-only"> file of {props.what}</span>
      </a>
    </p>
  );
}
