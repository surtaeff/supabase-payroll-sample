-- Row level security and the RPCs that move a payroll period forward.
--
-- Access model
-- * technician: reads and edits own draft entries, submits them. Cannot approve.
-- * office:     reads everything, approves or rejects entries, locks and exports periods.
-- * admin:      everything office can do, plus employees, periods and piece rates.
-- * anon:       nothing.
--
-- Helper calls are wrapped in (select ...) so Postgres evaluates them once per
-- statement instead of once per row.

-- ---------------------------------------------------------------------------
-- Helpers (schema "private" is not exposed through the API)
-- ---------------------------------------------------------------------------

create function private.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.employees e
  where e.user_id = auth.uid()
    and e.active
$$;

-- True if the caller has at least the given role (technician < office < admin).
create function private.has_role(p_min_role public.employee_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select e.role >= p_min_role
     from public.employees e
     where e.user_id = auth.uid()
       and e.active),
    false
  )
$$;

revoke all on schema private from public;
grant usage on schema private to authenticated;
revoke execute on all functions in schema private from public;
grant execute on function private.current_employee_id() to authenticated;
grant execute on function private.has_role(public.employee_role) to authenticated;
-- Called by the period lock trigger, which runs as the writing user.
grant execute on function private.assert_period_open(date) to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS, no access for anon
-- ---------------------------------------------------------------------------

alter table public.employees enable row level security;
alter table public.payroll_periods enable row level security;
alter table public.time_entries enable row level security;
alter table public.piece_rates enable row level security;
alter table public.piece_work_entries enable row level security;
alter table public.payroll_exports enable row level security;

revoke all on
  public.employees, public.payroll_periods, public.time_entries,
  public.piece_rates, public.piece_work_entries, public.payroll_exports
from anon;

-- Period status changes only through the RPCs below, never by a direct UPDATE.
revoke update on public.payroll_periods from authenticated;
-- Export records are written only by finalize_payroll_export().
revoke insert, update, delete on public.payroll_exports from authenticated;

-- ---------------------------------------------------------------------------
-- employees
-- ---------------------------------------------------------------------------

create policy employees_select on public.employees
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.has_role('office'))
  );

create policy employees_admin_write on public.employees
  for all to authenticated
  using ((select private.has_role('admin')))
  with check ((select private.has_role('admin')));

-- ---------------------------------------------------------------------------
-- payroll_periods: everyone signed in may read (the app shows if a month is closed)
-- ---------------------------------------------------------------------------

create policy payroll_periods_select on public.payroll_periods
  for select to authenticated
  using (true);

create policy payroll_periods_admin_insert on public.payroll_periods
  for insert to authenticated
  with check ((select private.has_role('admin')) and status = 'open');

create policy payroll_periods_admin_delete on public.payroll_periods
  for delete to authenticated
  using ((select private.has_role('admin')) and status = 'open');

-- ---------------------------------------------------------------------------
-- time_entries
-- ---------------------------------------------------------------------------

create policy time_entries_select on public.time_entries
  for select to authenticated
  using (
    employee_id = (select private.current_employee_id())
    or (select private.has_role('office'))
  );

create policy time_entries_own_insert on public.time_entries
  for insert to authenticated
  with check (
    employee_id = (select private.current_employee_id())
    and status in ('draft', 'submitted')
  );

-- A technician may change an entry only while it is a draft, and may only move it
-- to draft or submitted. approved_* stay null because of the status check constraint.
create policy time_entries_own_update on public.time_entries
  for update to authenticated
  using (
    employee_id = (select private.current_employee_id())
    and status = 'draft'
  )
  with check (
    employee_id = (select private.current_employee_id())
    and status in ('draft', 'submitted')
  );

create policy time_entries_own_delete on public.time_entries
  for delete to authenticated
  using (
    employee_id = (select private.current_employee_id())
    and status = 'draft'
  );

-- Office staff approve in their own name only.
create policy time_entries_office_all on public.time_entries
  for all to authenticated
  using ((select private.has_role('office')))
  with check (
    (select private.has_role('office'))
    and (status <> 'approved' or approved_by = (select private.current_employee_id()))
  );

-- ---------------------------------------------------------------------------
-- piece_rates
-- ---------------------------------------------------------------------------

create policy piece_rates_select on public.piece_rates
  for select to authenticated
  using (true);

create policy piece_rates_admin_write on public.piece_rates
  for all to authenticated
  using ((select private.has_role('admin')))
  with check ((select private.has_role('admin')));

-- ---------------------------------------------------------------------------
-- piece_work_entries (same rules as time_entries)
-- ---------------------------------------------------------------------------

create policy piece_work_select on public.piece_work_entries
  for select to authenticated
  using (
    employee_id = (select private.current_employee_id())
    or (select private.has_role('office'))
  );

create policy piece_work_own_insert on public.piece_work_entries
  for insert to authenticated
  with check (
    employee_id = (select private.current_employee_id())
    and status in ('draft', 'submitted')
  );

create policy piece_work_own_update on public.piece_work_entries
  for update to authenticated
  using (
    employee_id = (select private.current_employee_id())
    and status = 'draft'
  )
  with check (
    employee_id = (select private.current_employee_id())
    and status in ('draft', 'submitted')
  );

create policy piece_work_own_delete on public.piece_work_entries
  for delete to authenticated
  using (
    employee_id = (select private.current_employee_id())
    and status = 'draft'
  );

create policy piece_work_office_all on public.piece_work_entries
  for all to authenticated
  using ((select private.has_role('office')))
  with check (
    (select private.has_role('office'))
    and (status <> 'approved' or approved_by = (select private.current_employee_id()))
  );

-- ---------------------------------------------------------------------------
-- payroll_exports: read only, office and admin
-- ---------------------------------------------------------------------------

create policy payroll_exports_select on public.payroll_exports
  for select to authenticated
  using ((select private.has_role('office')));

-- ---------------------------------------------------------------------------
-- RPCs: open -> locked -> exported
--
-- Error codes (read by the Edge Function):
--   42501 caller is not office/admin
--   P0002 period not found
--   PR001 period is in the wrong state for this step
--   PR002 period still has draft or submitted entries
--   PR003 entry belongs to a period that is not open (trigger)
--   PR004 piece rate not valid on the work date (trigger)
-- ---------------------------------------------------------------------------

-- Locks the period. Safe to call again on a locked period (a previous export run may
-- have failed after locking), refuses an exported one.
create function public.lock_payroll_period(p_period_id uuid)
returns public.payroll_periods
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period public.payroll_periods;
  v_pending integer;
begin
  if not private.has_role('office') then
    raise exception 'only office staff can lock payroll periods' using errcode = '42501';
  end if;

  select * into v_period
  from public.payroll_periods
  where id = p_period_id
  for update;

  if not found then
    raise exception 'payroll period % not found', p_period_id using errcode = 'P0002';
  end if;

  if v_period.status = 'exported' then
    raise exception 'payroll period % is already exported', p_period_id
      using errcode = 'PR001';
  end if;

  if v_period.status = 'locked' then
    return v_period;
  end if;

  select
    (select count(*) from public.time_entries t
      where t.work_date between v_period.starts_on and v_period.ends_on
        and t.status in ('draft', 'submitted'))
    + (select count(*) from public.piece_work_entries w
      where w.work_date between v_period.starts_on and v_period.ends_on
        and w.status in ('draft', 'submitted'))
  into v_pending;

  if v_pending > 0 then
    raise exception '% entries in this period are not approved or rejected yet', v_pending
      using errcode = 'PR002', detail = json_build_object('pending', v_pending)::text;
  end if;

  update public.payroll_periods
  set status = 'locked',
      locked_at = now(),
      locked_by = private.current_employee_id()
  where id = p_period_id
  returning * into v_period;

  return v_period;
end;
$$;

-- Records the uploaded file and marks the period exported, in one transaction.
-- Calling it again with the same checksum returns the existing record.
create function public.finalize_payroll_export(
  p_period_id uuid,
  p_storage_path text,
  p_sha256 text,
  p_line_count integer
)
returns public.payroll_exports
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period public.payroll_periods;
  v_export public.payroll_exports;
begin
  if not private.has_role('office') then
    raise exception 'only office staff can export payroll' using errcode = '42501';
  end if;

  select * into v_period
  from public.payroll_periods
  where id = p_period_id
  for update;

  if not found then
    raise exception 'payroll period % not found', p_period_id using errcode = 'P0002';
  end if;

  if v_period.status = 'exported' then
    select * into v_export from public.payroll_exports where period_id = p_period_id;
    if v_export.sha256 = p_sha256 then
      return v_export;
    end if;
    raise exception 'payroll period % was already exported with different content', p_period_id
      using errcode = 'PR001';
  end if;

  if v_period.status <> 'locked' then
    raise exception 'payroll period % must be locked before export', p_period_id
      using errcode = 'PR001';
  end if;

  insert into public.payroll_exports (period_id, storage_path, sha256, line_count, created_by)
  values (p_period_id, p_storage_path, p_sha256, p_line_count, private.current_employee_id())
  returning * into v_export;

  update public.payroll_periods
  set status = 'exported'
  where id = p_period_id;

  return v_export;
end;
$$;

revoke execute on function public.lock_payroll_period(uuid) from public, anon;
revoke execute on function public.finalize_payroll_export(uuid, text, text, integer) from public, anon;
grant execute on function public.lock_payroll_period(uuid) to authenticated;
grant execute on function public.finalize_payroll_export(uuid, text, text, integer) to authenticated;
