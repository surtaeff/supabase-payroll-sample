-- Data integrity rules that hold no matter who writes: run as the table owner.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000003', 'tech1@example.test');

insert into public.employees (id, user_id, personnel_no, full_name, role) values
  ('e0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', '1003', 'Tech One', 'technician');

insert into public.payroll_periods (starts_on, ends_on, status, locked_at) values
  ('2026-09-01', '2026-09-30', 'locked', now()),
  ('2026-10-01', '2026-10-31', 'open', null);

insert into public.piece_rates (id, code, description, unit, rate_cents, wage_type, valid_from, valid_to) values
  ('b0000000-0000-0000-0000-000000000001', 'GUTTER_CLEAN_M', 'Gutter cleaning per metre', 'm', 185, '2100', '2026-10-01', null);

insert into public.time_entries (id, employee_id, started_at, ended_at, break_minutes) values
  ('c0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000003',
   '2026-10-05 07:00+02', '2026-10-05 15:30+02', 30);

-- Time entries ---------------------------------------------------------------

select throws_ok(
  $$insert into public.time_entries (employee_id, started_at, ended_at)
    values ('e0000000-0000-0000-0000-000000000003', '2026-10-05 15:00+02', '2026-10-05 17:00+02')$$,
  '23P01', null,
  'overlapping time entries of one employee are rejected'
);

update public.time_entries set status = 'rejected' where id = 'c0000000-0000-0000-0000-000000000001';

select lives_ok(
  $$insert into public.time_entries (employee_id, started_at, ended_at)
    values ('e0000000-0000-0000-0000-000000000003', '2026-10-05 15:00+02', '2026-10-05 17:00+02')$$,
  'a rejected entry does not block a corrected one'
);

select throws_ok(
  $$insert into public.time_entries (employee_id, started_at, ended_at)
    values ('e0000000-0000-0000-0000-000000000003', '2026-10-06 10:00+02', '2026-10-06 09:00+02')$$,
  '23514', null,
  'end before start is rejected'
);

select throws_ok(
  $$insert into public.time_entries (employee_id, started_at, ended_at, break_minutes)
    values ('e0000000-0000-0000-0000-000000000003', '2026-10-06 08:00+02', '2026-10-06 09:00+02', 60)$$,
  '23514', null,
  'a break as long as the shift is rejected'
);

select throws_ok(
  $$insert into public.time_entries (employee_id, started_at, ended_at, status)
    values ('e0000000-0000-0000-0000-000000000003', '2026-10-07 08:00+02', '2026-10-07 09:00+02', 'approved')$$,
  '23514', null,
  'approved without approver is rejected'
);

insert into public.time_entries (id, employee_id, started_at, ended_at) values
  ('c0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000003',
   '2026-10-08 22:30+00', '2026-10-09 02:00+00');

select is(
  (select work_date from public.time_entries where id = 'c0000000-0000-0000-0000-000000000002'),
  '2026-10-09'::date,
  'work_date follows Europe/Berlin: 22:30 UTC is 00:30 the next day'
);

-- Periods ------------------------------------------------------------------

select throws_ok(
  $$insert into public.payroll_periods (starts_on, ends_on) values ('2026-10-15', '2026-11-14')$$,
  '23P01', null,
  'payroll periods cannot overlap'
);

select throws_ok(
  $$insert into public.time_entries (employee_id, started_at, ended_at)
    values ('e0000000-0000-0000-0000-000000000003', '2026-09-10 08:00+02', '2026-09-10 12:00+02')$$,
  'PR003', null,
  'no new entries in a locked period'
);

select throws_ok(
  $$update public.time_entries set started_at = '2026-09-30 08:00+02', ended_at = '2026-09-30 09:00+02'
    where id = 'c0000000-0000-0000-0000-000000000002'$$,
  'PR003', null,
  'an entry cannot be moved into a locked period'
);

-- Unlock September briefly to create an entry, lock again, then try to change it.
update public.payroll_periods set status = 'open', locked_at = null where starts_on = '2026-09-01';
insert into public.time_entries (id, employee_id, started_at, ended_at) values
  ('c0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000003',
   '2026-09-10 08:00+02', '2026-09-10 12:00+02');
update public.payroll_periods set status = 'locked', locked_at = now() where starts_on = '2026-09-01';

select throws_ok(
  $$delete from public.time_entries where id = 'c0000000-0000-0000-0000-000000000003'$$,
  'PR003', null,
  'entries in a locked period cannot be deleted'
);

select lives_ok(
  $$insert into public.time_entries (employee_id, started_at, ended_at)
    values ('e0000000-0000-0000-0000-000000000003', '2026-12-01 08:00+01', '2026-12-01 12:00+01')$$,
  'days without a payroll period stay editable'
);

-- Piece work ---------------------------------------------------------------

select lives_ok(
  $$insert into public.piece_work_entries (employee_id, work_date, piece_rate_id, quantity)
    values ('e0000000-0000-0000-0000-000000000003', '2026-10-05', 'b0000000-0000-0000-0000-000000000001', 12.5)$$,
  'piece work inside the rate validity is accepted'
);

select throws_ok(
  $$insert into public.piece_work_entries (employee_id, work_date, piece_rate_id, quantity)
    values ('e0000000-0000-0000-0000-000000000003', '2026-08-15', 'b0000000-0000-0000-0000-000000000001', 1)$$,
  'PR004', null,
  'piece work before the rate was valid is rejected'
);

select throws_ok(
  $$insert into public.piece_work_entries (employee_id, work_date, piece_rate_id, quantity)
    values ('e0000000-0000-0000-0000-000000000003', '2026-10-05', 'b0000000-0000-0000-0000-000000000001', 0)$$,
  '23514', null,
  'zero quantity is rejected'
);

select throws_ok(
  $$insert into public.piece_rates (code, description, unit, rate_cents, wage_type, valid_from)
    values ('GUTTER_CLEAN_M', 'New price', 'm', 195, '2100', '2027-01-01')$$,
  '23P01', null,
  'a new price needs the old one closed first: validity ranges of one code cannot overlap'
);

select * from finish();
rollback;
