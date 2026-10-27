-- Migration 0015 — cancellation, credit and debit notes, returns (increment
-- 5.5: FR-TAX-3, FR-POS-3 AC5, FR-INV-6 AC1, D-016, D-042).

-- Credit/debit note lines point at the invoice line they correct.
alter table lbg.invoice_lines
  add constraint invoice_lines_business_id_uq unique (business_id, id),
  add column original_line_id uuid,
  add constraint invoice_lines_original_fk foreign key (business_id, original_line_id)
    references lbg.invoice_lines(business_id, id);
create index invoice_lines_original_idx on lbg.invoice_lines (business_id, original_line_id)
  where original_line_id is not null;

create index invoices_original_idx on lbg.invoices (business_id, original_invoice_id)
  where original_invoice_id is not null;
-- A credit or debit note states why it was issued.
alter table lbg.invoices
  add constraint invoices_note_reason check (
    document_type not in ('CREDIT_NOTE', 'DEBIT_NOTE') or status in ('DRAFT', 'DISCARDED') or length(notes) >= 10);

-- Refunds also pay back walk-in customers (no customer record) when an
-- invoice is cancelled or credited; `invoice_id` is the cancelled invoice or
-- the credit note that released the money.
alter table lbg.payment_refunds
  alter column customer_id drop not null,
  add column invoice_id uuid,
  add constraint payment_refunds_invoice_fk foreign key (business_id, invoice_id) references lbg.invoices(business_id, id);
