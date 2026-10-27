-- Migration 0009 — approval requests and stock adjustments (increment 4.3:
-- FR-INV-4 AC4, WORKFLOWS §11, rule R3).
-- New error code: LB017 approval request changed outside its state machine.

alter table lbg.approval_requests
  add column reason text check (length(reason) between 10 and 500),
  add column decision_note text check (length(decision_note) <= 500),
  add column executed_at timestamptz,
  add column result jsonb,
  add column error_code text check (error_code ~ '^[A-Z_]{1,40}$'),
  add constraint approval_requests_action_type check (action_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  add constraint approval_requests_permission check (required_permission ~ '^[a-z_]+(\.[a-z_]+)+$');
create index approval_requests_status_idx on lbg.approval_requests (business_id, status, created_at desc);

-- WORKFLOWS §11: PENDING → APPROVED → EXECUTED | EXECUTION_FAILED,
-- PENDING → REJECTED | EXPIRED | CANCELLED. The request itself (who, what,
-- payload and its hash, required permission, expiry) never changes.
create function lbg.approval_request_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if new.business_id is distinct from old.business_id or new.requested_by is distinct from old.requested_by
     or new.action_type is distinct from old.action_type or new.payload is distinct from old.payload
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.required_permission is distinct from old.required_permission
     or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at
     or new.reason is distinct from old.reason then
    raise exception 'an approval request cannot be edited' using errcode = 'LB017';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'PENDING' and new.status in ('APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    or (old.status = 'APPROVED' and new.status in ('EXECUTED', 'EXECUTION_FAILED'))) then
    raise exception 'approval status % -> % not allowed', old.status, new.status using errcode = 'LB017';
  end if;
  if old.status not in ('PENDING', 'APPROVED') and new is distinct from old then
    raise exception 'a % approval request is final', old.status using errcode = 'LB017';
  end if;
  return new;
end
$$;
create trigger approval_requests_guard before update on lbg.approval_requests
  for each row execute function lbg.approval_request_guard();

-- Active members of the current business holding a permission (rule R3 needs
-- to know whether anyone other than the requester could approve).
create function lbg.members_with_permission(p_permission text) returns setof uuid
language sql stable set search_path = lbg, public, pg_temp as $$
  select distinct m.user_id
    from memberships m
    join membership_roles mr on mr.business_id = m.business_id and mr.membership_id = m.id
    join role_permissions rp on rp.business_id = mr.business_id and rp.role_id = mr.role_id
   where m.business_id = current_business_id() and m.status = 'ACTIVE' and rp.permission_key = p_permission
$$;

revoke execute on function lbg.approval_request_guard(), lbg.members_with_permission(text) from public;
grant execute on function lbg.members_with_permission(text) to lbgos_app;
