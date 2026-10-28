-- The shop's full address (Phase 14, D-073): stored as fields; the printed
-- one-line address (business_address, used by invoices and the shop's
-- website) is composed from them by the app. The state is the business's GST
-- state: the app may change it only while the business is being set up.

alter table lbg.business_settings
  add column address_line1 text check (length(address_line1) between 1 and 120),
  add column address_line2 text check (length(address_line2) between 1 and 120),
  add column landmark      text check (length(landmark) between 1 and 120),
  add column city          text check (length(city) between 1 and 80),
  add column district      text check (length(district) between 1 and 80),
  add column pincode       text check (pincode ~ '^[1-9][0-9]{5}$');

grant update (state_code) on lbg.businesses to lbgos_app;

create function lbg.business_state_only_in_setup() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if new.state_code is distinct from old.state_code and old.status <> 'APPROVED_SETUP_PENDING'
     and current_user = 'lbgos_app' then
    raise exception 'the state can be changed only during setup' using errcode = 'LB024';
  end if;
  return new;
end
$$;
create trigger businesses_state_only_in_setup before update of state_code on lbg.businesses
  for each row execute function lbg.business_state_only_in_setup();
