-- Payroll core: employees, payroll periods, time entries, piece-rate work and exports.
--
-- Design notes
-- * Money is stored as integer cents, quantities as numeric(10,2). No floats anywhere.
-- * work_date is derived from started_at in Europe/Berlin, so a shift that starts at
--   23:30 local time belongs to that day even though it is stored in UTC.
-- * Overlaps are prevented by the database (exclusion constraints), not by the UI.
-- * A payroll period moves open -> locked -> exported only through the RPCs below.
--   While a period is not open, entries inside it cannot be inserted, changed or deleted.

create extension if not exists btree_gist with schema extensions;

create schema if not exists private;

create type public.employee_role as enum ('technician', 'office', 'admin');
create type public.entry_status as enum ('draft', 'submitted', 'approved', 'rejected');
create type public.period_status as enum ('open', 'locked', 'exported');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  personnel_no text not null unique,            -- personnel number in the payroll software
  full_name text not null,
  role public.employee_role not null default 'technician',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.payroll_periods (
  id uuid primary key default gen_random_uuid(),
  starts_on date not null,
  ends_on date not null,
  status public.period_status not null default 'open',
  locked_at timestamptz,
  locked_by uuid references public.employees (id),
  created_at timestamptz not null default now(),
  constraint payroll_periods_valid_range check (ends_on >= starts_on),
  constraint payroll_periods_no_overlap
    exclude using gist (daterange(starts_on, ends_on, '[]') with &&),
  constraint payroll_periods_lock_consistent
    check ((status = 'open') = (locked_at is null))
);

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  break_minutes integer not null default 0,
  work_date date generated always as ((started_at at time zone 'Europe/Berlin')::date) stored,
  status public.entry_status not null default 'draft',
  note text,
  approved_by uuid references public.employees (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint time_entries_positive_duration check (ended_at > started_at),
  constraint time_entries_max_shift check (ended_at - started_at <= interval '16 hours'),
  constraint time_entries_break_fits
    check (break_minutes >= 0 and break_minutes * interval '1 minute' < ended_at - started_at),
  constraint time_entries_approval_consistent
    check ((status = 'approved') = (approved_by is not null and approved_at is not null)),
  -- Rejected entries stay for the audit trail and must not block a corrected entry.
  constraint time_entries_no_overlap
    exclude using gist (employee_id with =, tstzrange(started_at, ended_at) with &&)
    where (status <> 'rejected')
);

create index time_entries_work_date_idx on public.time_entries (work_date, status);

create table public.piece_rates (
  id uuid primary key default gen_random_uuid(),
  code text not null,                           -- e.g. GUTTER_CLEAN_M
  description text not null,
  unit text not null check (unit in ('m', 'm2', 'pcs')),
  rate_cents integer not null check (rate_cents >= 0),
  wage_type text not null,                      -- wage type code in the payroll software
  valid_from date not null,
  valid_to date,                                -- null = open ended
  constraint piece_rates_valid_range check (valid_to is null or valid_to >= valid_from),
  constraint piece_rates_no_overlap
    exclude using gist (code with =, daterange(valid_from, valid_to, '[]') with &&)
);

create table public.piece_work_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  work_date date not null,
  piece_rate_id uuid not null references public.piece_rates (id) on delete restrict,
  quantity numeric(10, 2) not null check (quantity > 0),
  status public.entry_status not null default 'draft',
  note text,
  approved_by uuid references public.employees (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint piece_work_approval_consistent
    check ((status = 'approved') = (approved_by is not null and approved_at is not null))
);

create index piece_work_entries_employee_idx on public.piece_work_entries (employee_id);
create index piece_work_entries_work_date_idx on public.piece_work_entries (work_date, status);
create index time_entries_employee_idx on public.time_entries (employee_id);

create table public.payroll_exports (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null unique references public.payroll_periods (id) on delete restrict,
  storage_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  line_count integer not null check (line_count >= 0),
  created_by uuid not null references public.employees (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- The piece rate must be valid on the day the work was done.
create function private.check_piece_rate_valid()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.piece_rates r
    where r.id = new.piece_rate_id
      and new.work_date >= r.valid_from
      and (r.valid_to is null or new.work_date <= r.valid_to)
  ) then
    raise exception 'piece rate % is not valid on %', new.piece_rate_id, new.work_date
      using errcode = 'PR004';
  end if;
  return new;
end;
$$;

create trigger piece_work_entries_rate_valid
  before insert or update of piece_rate_id, work_date on public.piece_work_entries
  for each row execute function private.check_piece_rate_valid();

-- Entries in a locked or exported period are frozen. Days without a period stay editable.
-- security definer: the answer must not depend on the caller's RLS view of periods.
create function private.assert_period_open(p_day date)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status public.period_status;
begin
  select p.status into v_status
  from public.payroll_periods p
  where p_day between p.starts_on and p.ends_on;

  if v_status is not null and v_status <> 'open' then
    raise exception 'payroll period for % is %', p_day, v_status
      using errcode = 'PR003';
  end if;
end;
$$;

create function private.guard_period_open()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.assert_period_open(old.work_date);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    -- work_date of time_entries is a generated column and not yet computed in a
    -- BEFORE trigger, so derive it from started_at for that table.
    perform private.assert_period_open(
      case tg_table_name
        when 'time_entries' then ((to_jsonb(new) ->> 'started_at')::timestamptz at time zone 'Europe/Berlin')::date
        else (to_jsonb(new) ->> 'work_date')::date
      end
    );
  end if;
  return coalesce(new, old);
end;
$$;

create trigger time_entries_period_open
  before insert or update or delete on public.time_entries
  for each row execute function private.guard_period_open();

create trigger piece_work_entries_period_open
  before insert or update or delete on public.piece_work_entries
  for each row execute function private.guard_period_open();
