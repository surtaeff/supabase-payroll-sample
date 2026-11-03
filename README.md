# Supabase payroll sample

An anonymised, self-contained sample of how I build on Supabase: one slice of a
field-service payroll module (time tracking, piece-rate work, monthly payroll export).
Names, codes and rates are made up.

| What was asked for | Where |
| --- | --- |
| Migration | [`supabase/migrations/20261101090000_payroll_core.sql`](supabase/migrations/20261101090000_payroll_core.sql) |
| RLS policies | [`supabase/migrations/20261101090100_payroll_rls.sql`](supabase/migrations/20261101090100_payroll_rls.sql) |
| Edge Function | [`supabase/functions/payroll-export/`](supabase/functions/payroll-export/) |
| Tests | [`supabase/tests/database/`](supabase/tests/database/) (pgTAP), [`supabase/functions/tests/`](supabase/functions/tests/) (Deno) |

## The scenario

Technicians record working time and piece work (metres of gutter cleaned, pieces
installed) in the field. The office approves or rejects entries. At month end the
office exports the period as a CSV for the payroll software, after which the month is
frozen.

```
entry:  draft -> submitted -> approved | rejected
period: open  -> locked (all entries decided) -> exported (file stored, checksum recorded)
```

## Decisions worth a look

**Database**

- The database enforces the rules, not the UI: exclusion constraints stop overlapping
  shifts (a rejected entry does not block its correction), overlapping payroll periods
  and overlapping price validity per piece rate. Check constraints keep approval data
  consistent with status.
- Money in integer cents, quantities in `numeric(10,2)`. No floats.
- `work_date` is generated from `started_at` in Europe/Berlin, so a shift starting at
  00:30 local time is booked on the right day although it is stored in UTC.
- Once a period is locked, a trigger blocks insert, update and delete of entries in it,
  for every role including office.
- Period status changes only through two RPCs (`lock_payroll_period`,
  `finalize_payroll_export`). Direct `UPDATE` on periods and any write on exports are
  revoked. Custom SQLSTATE codes (`PR001` to `PR004`) let the API return precise errors.

**RLS** (following the Supabase RLS performance guide)

- Technicians see and edit only their own drafts and can submit them. Office approves,
  and only in its own name. Admin manages master data. Anon gets nothing.
- Role lookups are `security definer` helpers in a non-exposed `private` schema with
  `search_path = ''`, called as `(select ...)` so they run once per statement.
- Every policy is `to authenticated`; queries also filter explicitly so the planner can
  use indexes instead of relying on RLS for filtering.

**Edge Function** `payroll-export`

- Thin `index.ts`; the handler gets its dependencies injected (`Deps`), so HTTP
  behaviour is tested without a network or database. Calculation and CSV are pure
  modules in `_shared/`.
- Database reads run with the caller's JWT, so RLS applies. The service role key is
  used for one thing only: writing the file to the private bucket.
- Every step is safe to retry: locking a locked period is a no-op, the file path
  contains the SHA-256 of its content, and finalizing twice with the same checksum
  returns the first record. If a run fails halfway, the office just runs it again.

**Business rules** (in [`_shared/payroll.ts`](supabase/functions/_shared/payroll.ts))

- Hours are summed per employee before rounding. Rounding each entry first would lose
  minutes every month (three 20-minute entries are 1.00 h, not 0.99 h).
- Piece work is priced per entry, half up to the cent, then summed per wage type.
- Days where the break is below the German Working Hours Act minimum (30 min above 6 h,
  45 min above 9 h; gaps of 15 min or more count) are returned as warnings for the
  office. Pay is never changed silently.
- Output is sorted, so the same data always gives the same file and checksum.

## Tests

```bash
deno task test        # 25 Deno tests: rules, rounding, DST, CSV format, HTTP handler
deno task check       # type check, including the supabase-js adapter
deno task test:db     # 42 pgTAP tests on a throwaway Postgres (needs Postgres 14+ and pgTAP)
```

With the Supabase CLI the database tests run as usual: `supabase db reset && supabase test db`.
`scripts/test-db.sh` loads a small stub of the Supabase roles and `auth.uid()`
(`scripts/supabase-stub.sql`) so CI needs neither Docker nor the CLI.

The pgTAP suites cover:

- `01_constraints`: overlaps, invalid durations and breaks, approval consistency, Berlin
  work date, period overlap, frozen periods, piece rate validity.
- `02_rls`: each role through the API roles (`anon`, `authenticated` with JWT claims),
  `policies_are`, own vs colleague's rows, self-approval, the full
  open -> locked -> exported flow with retries and refusals.

The suites were checked against deliberate mistakes: an extra `using (true)` policy and
an off-by-one in the break threshold both turn the run red.

## Not included on purpose

UI, auth setup, seed data, and the real payroll format (the CSV here is generic:
semicolon, decimal comma, UTF-8 BOM, CRLF).
