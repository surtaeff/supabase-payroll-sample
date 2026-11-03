import { calculatePayroll, type PayrollInput, PayrollInputError } from "../_shared/payroll.ts";
import { toPayrollCsv } from "../_shared/csv.ts";

/**
 * POST /payroll-export  { "period_id": "<uuid>" }
 *
 * 1. lock the period (refused while entries are still draft or submitted)
 * 2. load approved entries with the caller's token, so RLS applies
 * 3. calculate lines and build the CSV (pure code, see _shared)
 * 4. upload the file under a content-addressed path
 * 5. record the export and mark the period exported in one DB transaction
 *
 * Every step can be retried: locking a locked period is a no-op, the upload path
 * contains the checksum, and finalizing twice with the same checksum returns the
 * first record. A run that dies between steps is fixed by running it again.
 */

export type Role = "technician" | "office" | "admin";

export interface Caller {
  employeeId: string;
  role: Role;
}

export interface PeriodData extends Omit<PayrollInput, "hoursWageType"> {
  startsOn: string;
  endsOn: string;
}

export interface ExportRecord {
  id: string;
  storagePath: string;
  sha256: string;
  lineCount: number;
}

/** Everything the handler needs from the outside world. Real implementation: deps.ts */
export interface Deps {
  getCaller(): Promise<Caller | null>;
  lockPeriod(periodId: string): Promise<void>;
  loadPeriodData(periodId: string): Promise<PeriodData>;
  upload(path: string, content: string): Promise<void>;
  finalizeExport(args: {
    periodId: string;
    storagePath: string;
    sha256: string;
    lineCount: number;
  }): Promise<ExportRecord>;
}

export type DomainErrorCode =
  | "forbidden"
  | "period_not_found"
  | "period_not_exportable"
  | "unapproved_entries";

export class DomainError extends Error {
  override name = "DomainError";
  constructor(readonly code: DomainErrorCode, message: string) {
    super(message);
  }
}

const STATUS: Record<DomainErrorCode, number> = {
  forbidden: 403,
  period_not_found: 404,
  period_not_exportable: 409,
  unapproved_entries: 409,
};

/** Maps the SQLSTATE codes raised by the migration's RPCs to domain errors. */
export function mapDbError(error: { code?: string; message?: string }): Error {
  const message = error.message ?? "database error";
  switch (error.code) {
    case "42501":
      return new DomainError("forbidden", message);
    case "P0002":
      return new DomainError("period_not_found", message);
    case "PR001":
      return new DomainError("period_not_exportable", message);
    case "PR002":
      return new DomainError("unapproved_entries", message);
    default:
      return new Error(`${error.code ?? "unknown"}: ${message}`);
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const HOURS_WAGE_TYPE = "1000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createHandler(depsFor: (authorization: string) => Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json(401, { error: "unauthorized" });

    let periodId: unknown;
    try {
      periodId = (await req.json())?.period_id;
    } catch {
      return json(400, { error: "invalid_json" });
    }
    if (typeof periodId !== "string" || !UUID.test(periodId)) {
      return json(400, { error: "period_id must be a uuid" });
    }

    const deps = depsFor(authorization);
    try {
      const caller = await deps.getCaller();
      if (!caller) return json(401, { error: "unauthorized" });
      // Checked again inside the RPCs; this only gives a clean early answer.
      if (caller.role === "technician") return json(403, { error: "forbidden" });

      await deps.lockPeriod(periodId);
      const data = await deps.loadPeriodData(periodId);
      const { lines, warnings } = calculatePayroll({ ...data, hoursWageType: HOURS_WAGE_TYPE });
      const csv = toPayrollCsv(lines);
      const sha256 = await sha256Hex(csv);
      const storagePath = `${data.startsOn}_${data.endsOn}/${sha256}.csv`;

      await deps.upload(storagePath, csv);
      const record = await deps.finalizeExport({
        periodId,
        storagePath,
        sha256,
        lineCount: lines.length,
      });

      return json(200, { export: record, warnings });
    } catch (error) {
      if (error instanceof DomainError) {
        return json(STATUS[error.code], { error: error.code, message: error.message });
      }
      if (error instanceof PayrollInputError) {
        return json(422, { error: "invalid_payroll_data", message: error.message });
      }
      console.error("payroll-export failed", { periodId, error });
      return json(500, { error: "internal_error" });
    }
  };
}
