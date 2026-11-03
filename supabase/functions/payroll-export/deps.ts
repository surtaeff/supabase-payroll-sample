import { createClient } from "@supabase/supabase-js";
import { type Caller, type Deps, mapDbError, type PeriodData } from "./handler.ts";

const BUCKET = "payroll-exports";

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

/**
 * Database access runs with the caller's JWT, so RLS decides what is visible.
 * The service role key is used for one thing only: writing to the private bucket,
 * after the caller passed the role check in lock_payroll_period().
 */
export function supabaseDeps(authorization: string): Deps {
  const url = env("SUPABASE_URL");
  const db = createClient(url, env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const storage = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  }).storage;

  return {
    async getCaller(): Promise<Caller | null> {
      // getClaims verifies the JWT locally against the project's asymmetric signing
      // keys (cached JWKS), so no round trip to Auth per call. Projects still on the
      // legacy symmetric secret fall back to an Auth request automatically.
      const { data: auth, error: authError } = await db.auth.getClaims(
        authorization.replace(/^Bearer /, ""),
      );
      const userId = auth?.claims.sub;
      if (authError || !userId) return null;
      const { data, error } = await db
        .from("employees")
        .select("id, role")
        .eq("user_id", userId)
        .eq("active", true)
        .maybeSingle();
      if (error) throw mapDbError(error);
      return data ? { employeeId: data.id, role: data.role } : null;
    },

    async lockPeriod(periodId) {
      const { error } = await db.rpc("lock_payroll_period", { p_period_id: periodId });
      if (error) throw mapDbError(error);
    },

    async loadPeriodData(periodId): Promise<PeriodData> {
      const period = await db
        .from("payroll_periods")
        .select("starts_on, ends_on")
        .eq("id", periodId)
        .single();
      if (period.error) throw mapDbError(period.error);
      const { starts_on: startsOn, ends_on: endsOn } = period.data;

      // Filters repeat what RLS allows: RLS is for security, the filter is for the planner.
      const [times, pieces] = await Promise.all([
        db.from("time_entries")
          .select("id, employee_id, work_date, started_at, ended_at, break_minutes")
          .eq("status", "approved")
          .gte("work_date", startsOn)
          .lte("work_date", endsOn),
        db.from("piece_work_entries")
          .select("id, employee_id, work_date, quantity::text, piece_rates(rate_cents, wage_type, unit)")
          .eq("status", "approved")
          .gte("work_date", startsOn)
          .lte("work_date", endsOn),
      ]);
      if (times.error) throw mapDbError(times.error);
      if (pieces.error) throw mapDbError(pieces.error);

      const employeeIds = [
        ...new Set([...times.data, ...pieces.data].map((row) => row.employee_id)),
      ];
      const employees = await db
        .from("employees")
        .select("id, personnel_no, full_name")
        .in("id", employeeIds);
      if (employees.error) throw mapDbError(employees.error);

      return {
        startsOn,
        endsOn,
        employees: employees.data.map((e) => ({
          id: e.id,
          personnelNo: e.personnel_no,
          fullName: e.full_name,
        })),
        timeEntries: times.data.map((t) => ({
          id: t.id,
          employeeId: t.employee_id,
          workDate: t.work_date,
          startedAt: t.started_at,
          endedAt: t.ended_at,
          breakMinutes: t.break_minutes,
        })),
        pieceWork: pieces.data.map((p) => {
          const rate = p.piece_rates as unknown as { rate_cents: number; wage_type: string; unit: string };
          return {
            id: p.id,
            employeeId: p.employee_id,
            workDate: p.work_date,
            quantity: p.quantity,
            rateCents: rate.rate_cents,
            wageType: rate.wage_type,
            unit: rate.unit,
          };
        }),
      };
    },

    async upload(path, content) {
      const { error } = await storage.from(BUCKET).upload(path, new Blob([content]), {
        contentType: "text/csv; charset=utf-8",
        upsert: true, // same path means same content, so a retry is harmless
      });
      if (error) throw new Error(`upload failed: ${error.message}`);
    },

    async finalizeExport({ periodId, storagePath, sha256, lineCount }) {
      const { data, error } = await db
        .rpc("finalize_payroll_export", {
          p_period_id: periodId,
          p_storage_path: storagePath,
          p_sha256: sha256,
          p_line_count: lineCount,
        })
        .single<{ id: string; storage_path: string; sha256: string; line_count: number }>();
      if (error) throw mapDbError(error);
      return {
        id: data.id,
        storagePath: data.storage_path,
        sha256: data.sha256,
        lineCount: data.line_count,
      };
    },
  };
}
