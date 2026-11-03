-- Row level security and the export RPCs, tested as the roles the API uses.
-- "as <user>" = set local role authenticated + JWT claims, like PostgREST does.
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- Fixture (as owner) -------------------------------------------------------

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'admin@example.test'),
  ('a0000000-0000-0000-0000-000000000002', 'office@example.test'),
  ('a0000000-0000-0000-0000-000000000003', 'tech1@example.test'),
  ('a0000000-0000-0000-0000-000000000004', 'tech2@example.test');

insert into public.employees (id, user_id, personnel_no, full_name, role) values
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '1001', 'Admin', 'admin'),
  ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', '1002', 'Office', 'office'),
  ('e0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', '1003', 'Tech One', 'technician'),
  ('e0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', '1004', 'Tech Two', 'technician');

insert into public.payroll_periods (id, starts_on, ends_on) values
  ('d0000000-0000-0000-0000-000000000010', '2026-10-01', '2026-10-31');

insert into public.time_entries (id, employee_id, started_at, ended_at, status) values
  ('c0000000-0000-0000-0000-000000000031', 'e0000000-0000-0000-0000-000000000003', '2026-10-05 07:00+02', '2026-10-05 15:00+02', 'draft'),
  ('c0000000-0000-0000-0000-000000000032', 'e0000000-0000-0000-0000-000000000003', '2026-10-06 07:00+02', '2026-10-06 15:00+02', 'submitted'),
  ('c0000000-0000-0000-0000-000000000041', 'e0000000-0000-0000-0000-000000000004', '2026-10-05 07:00+02', '2026-10-05 15:00+02', 'submitted');

-- Policies exist as designed (Supabase docs: policies_are) ----------------

select policies_are('public', 'time_entries', array[
  'time_entries_select', 'time_entries_own_insert', 'time_entries_own_update',
  'time_entries_own_delete', 'time_entries_office_all'
]);

-- anon ----------------------------------------------------------------------

set local role anon;

select throws_ok($$select * from public.time_entries$$, '42501', null, 'anon cannot read time entries');
select throws_ok(
  $$select public.lock_payroll_period('d0000000-0000-0000-0000-000000000010')$$,
  '42501', null, 'anon cannot call the export RPCs'
);

-- technician ---------------------------------------------------------------

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);

select is((select count(*)::int from public.time_entries), 2, 'technician sees only own time entries');
select is((select count(*)::int from public.employees), 1, 'technician sees only own employee row');

select lives_ok(
  $$insert into public.time_entries (employee_id, started_at, ended_at)
    values ('e0000000-0000-0000-0000-000000000003', '2026-10-07 07:00+02', '2026-10-07 12:00+02')$$,
  'technician can add own entry'
);

select throws_ok(
  $$insert into public.time_entries (employee_id, started_at, ended_at)
    values ('e0000000-0000-0000-0000-000000000004', '2026-10-08 07:00+02', '2026-10-08 12:00+02')$$,
  '42501', null,
  'technician cannot add entries for a colleague'
);

select throws_ok(
  $$update public.time_entries
    set status = 'approved', approved_by = 'e0000000-0000-0000-0000-000000000003', approved_at = now()
    where id = 'c0000000-0000-0000-0000-000000000031'$$,
  '42501', null,
  'technician cannot approve own entry'
);

update public.time_entries set status = 'submitted' where id = 'c0000000-0000-0000-0000-000000000031';
update public.time_entries set break_minutes = 120 where id = 'c0000000-0000-0000-0000-000000000031';
delete from public.time_entries where id = 'c0000000-0000-0000-0000-000000000041';

select throws_ok(
  $$update public.payroll_periods set status = 'exported'$$,
  '42501', null,
  'technician cannot change a period status directly'
);

select throws_ok(
  $$select public.lock_payroll_period('d0000000-0000-0000-0000-000000000010')$$,
  '42501', null,
  'technician cannot lock a period'
);

select is_empty($$select * from public.payroll_exports$$, 'technician cannot see payroll exports');

reset role;

select is(
  (select status::text from public.time_entries where id = 'c0000000-0000-0000-0000-000000000031'),
  'submitted', 'technician can submit own draft'
);
select is(
  (select break_minutes from public.time_entries where id = 'c0000000-0000-0000-0000-000000000031'),
  0, 'a submitted entry is no longer editable by the technician'
);
select isnt_empty(
  $$select 1 from public.time_entries where id = 'c0000000-0000-0000-0000-000000000041'$$,
  'technician cannot delete a colleague''s entry'
);

-- office -------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);

select is((select count(*)::int from public.time_entries), 4, 'office sees all time entries');

select throws_ok(
  $$update public.time_entries
    set status = 'approved', approved_by = 'e0000000-0000-0000-0000-000000000001', approved_at = now()
    where id = 'c0000000-0000-0000-0000-000000000041'$$,
  '42501', null,
  'office cannot approve in someone else''s name'
);

select throws_ok(
  $$select public.lock_payroll_period('d0000000-0000-0000-0000-000000000010')$$,
  'PR002', null,
  'period cannot be locked while entries wait for approval'
);

update public.time_entries
set status = 'approved', approved_by = 'e0000000-0000-0000-0000-000000000002', approved_at = now()
where status = 'submitted';
update public.time_entries set status = 'rejected' where status = 'draft';

select is(
  (select status::text from public.lock_payroll_period('d0000000-0000-0000-0000-000000000010')),
  'locked', 'office locks the period once everything is approved or rejected'
);

select lives_ok(
  $$select public.lock_payroll_period('d0000000-0000-0000-0000-000000000010')$$,
  'locking again is a no-op, so a failed export run can be retried'
);

select throws_ok(
  $$update public.time_entries set note = 'late fix' where id = 'c0000000-0000-0000-0000-000000000041'$$,
  'PR003', null,
  'even office cannot change entries of a locked period'
);

select is(
  (select line_count from public.finalize_payroll_export(
    'd0000000-0000-0000-0000-000000000010', '2026-10-01_2026-10-31/abc.csv', repeat('a', 64), 3)),
  3, 'office finalizes the export'
);

select is(
  (select status::text from public.payroll_periods where id = 'd0000000-0000-0000-0000-000000000010'),
  'exported', 'the period is exported in the same transaction'
);

select is(
  (select count(*)::int from public.finalize_payroll_export(
    'd0000000-0000-0000-0000-000000000010', '2026-10-01_2026-10-31/abc.csv', repeat('a', 64), 3)),
  1, 'finalizing again with the same checksum returns the existing export'
);

select throws_ok(
  $$select public.finalize_payroll_export(
    'd0000000-0000-0000-0000-000000000010', 'other.csv', repeat('b', 64), 3)$$,
  'PR001', null,
  'a second export with different content is refused'
);

select throws_ok(
  $$select public.lock_payroll_period('d0000000-0000-0000-0000-000000000010')$$,
  'PR001', null,
  'an exported period cannot be locked again'
);

select is((select count(*)::int from public.payroll_exports), 1, 'office can read exports');

-- unknown period -----------------------------------------------------------

select throws_ok(
  $$select public.lock_payroll_period('d0000000-0000-0000-0000-0000000000ff')$$,
  'P0002', null,
  'unknown period is reported as not found'
);

reset role;
select * from finish();
rollback;
