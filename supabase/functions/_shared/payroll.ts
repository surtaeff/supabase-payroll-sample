/**
 * Pure payroll calculation. No I/O, so every rule is covered by fast unit tests.
 *
 * Rules
 * - Hours: net minutes (duration minus break) are summed per employee first and
 *   converted to hours once, rounded half up to 2 decimals. Rounding per entry
 *   would drift by several minutes per month.
 * - Piece work: amount per entry = quantity x rate, rounded half up to the cent,
 *   then summed per employee, wage type and unit. Integer math only.
 * - Breaks: German Working Hours Act (ArbZG section 4) requires 30 minutes for more
 *   than 6 hours of work per day and 45 minutes for more than 9 hours. Gaps of at
 *   least 15 minutes between entries count as breaks. A shortfall is reported as a
 *   warning for the office; pay is never changed silently.
 * - Output is sorted, so the same input always gives the same file and checksum.
 */

export interface Employee {
  id: string;
  personnelNo: string;
  fullName: string;
}

export interface TimeEntry {
  id: string;
  employeeId: string;
  workDate: string; // YYYY-MM-DD, Europe/Berlin
  startedAt: string; // ISO 8601 with offset
  endedAt: string;
  breakMinutes: number;
}

export interface PieceWorkEntry {
  id: string;
  employeeId: string;
  workDate: string;
  quantity: string; // numeric(10,2) arrives as a string, never parse it as float
  rateCents: number;
  wageType: string;
  unit: string;
}

export interface PayrollInput {
  employees: Employee[];
  timeEntries: TimeEntry[];
  pieceWork: PieceWorkEntry[];
  hoursWageType: string;
}

export interface PayrollLine {
  personnelNo: string;
  fullName: string;
  wageType: string;
  unit: string;
  /** Hundredths of the unit (hours or piece unit). 750 = 7.50 */
  quantityHundredths: number;
  /** null for hour lines: the payroll software applies the hourly wage. */
  amountCents: number | null;
}

export interface PayrollWarning {
  code: "BREAK_BELOW_STATUTORY_MINIMUM";
  employeeId: string;
  workDate: string;
  message: string;
}

export interface PayrollResult {
  lines: PayrollLine[];
  warnings: PayrollWarning[];
}

export class PayrollInputError extends Error {
  override name = "PayrollInputError";
}

const MINUTE_MS = 60_000;

/** Byte-order comparison: unlike localeCompare it does not depend on the runtime locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const MIN_COUNTED_GAP_MINUTES = 15;

export function netMinutes(entry: TimeEntry): number {
  const start = Date.parse(entry.startedAt);
  const end = Date.parse(entry.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new PayrollInputError(`time entry ${entry.id} has an invalid timestamp`);
  }
  const gross = (end - start) / MINUTE_MS;
  if (!Number.isInteger(gross)) {
    throw new PayrollInputError(`time entry ${entry.id} is not on whole minutes`);
  }
  const net = gross - entry.breakMinutes;
  if (entry.breakMinutes < 0 || net <= 0) {
    throw new PayrollInputError(`time entry ${entry.id} has no positive working time`);
  }
  return net;
}

/** Minimum break in minutes for the given daily working time (ArbZG section 4). */
export function statutoryBreakMinutes(workedMinutes: number): number {
  if (workedMinutes > 9 * 60) return 45;
  if (workedMinutes > 6 * 60) return 30;
  return 0;
}

/** "12.5" -> 1250. Accepts up to two decimals, rejects anything else. */
export function parseHundredths(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new PayrollInputError(`invalid quantity "${value}"`);
  const [, whole, fraction = ""] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Round half up for non-negative integers: numerator / denominator. */
function divRoundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function minutesToHundredthsOfHour(minutes: number): number {
  return divRoundHalfUp(minutes * 100, 60);
}

export function pieceAmountCents(quantityHundredths: number, rateCents: number): number {
  return divRoundHalfUp(quantityHundredths * rateCents, 100);
}

export function breakWarnings(entries: TimeEntry[]): PayrollWarning[] {
  const byDay = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    const key = `${entry.employeeId}|${entry.workDate}`;
    byDay.set(key, [...(byDay.get(key) ?? []), entry]);
  }

  const warnings: PayrollWarning[] = [];
  for (const dayEntries of byDay.values()) {
    const sorted = [...dayEntries].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    let worked = 0;
    let breaks = 0;
    for (let i = 0; i < sorted.length; i++) {
      worked += netMinutes(sorted[i]);
      breaks += sorted[i].breakMinutes;
      if (i > 0) {
        const gap = (Date.parse(sorted[i].startedAt) - Date.parse(sorted[i - 1].endedAt)) / MINUTE_MS;
        if (gap >= MIN_COUNTED_GAP_MINUTES) breaks += gap;
      }
    }
    const required = statutoryBreakMinutes(worked);
    if (breaks < required) {
      const { employeeId, workDate } = sorted[0];
      warnings.push({
        code: "BREAK_BELOW_STATUTORY_MINIMUM",
        employeeId,
        workDate,
        message: `${worked} min worked with ${breaks} min break, at least ${required} min required`,
      });
    }
  }
  return warnings.sort((a, b) => cmp(a.employeeId, b.employeeId) || cmp(a.workDate, b.workDate));
}

export function calculatePayroll(input: PayrollInput): PayrollResult {
  const employees = new Map(input.employees.map((e) => [e.id, e]));
  const employeeOf = (id: string, entryId: string): Employee => {
    const employee = employees.get(id);
    if (!employee) throw new PayrollInputError(`entry ${entryId} references unknown employee ${id}`);
    return employee;
  };

  const lines = new Map<string, PayrollLine>();
  const lineFor = (employee: Employee, wageType: string, unit: string, priced: boolean) => {
    const key = `${employee.id}|${wageType}|${unit}`;
    let line = lines.get(key);
    if (!line) {
      line = {
        personnelNo: employee.personnelNo,
        fullName: employee.fullName,
        wageType,
        unit,
        quantityHundredths: 0,
        amountCents: priced ? 0 : null,
      };
      lines.set(key, line);
    }
    return line;
  };

  const minutesByEmployee = new Map<string, number>();
  for (const entry of input.timeEntries) {
    employeeOf(entry.employeeId, entry.id);
    minutesByEmployee.set(
      entry.employeeId,
      (minutesByEmployee.get(entry.employeeId) ?? 0) + netMinutes(entry),
    );
  }
  for (const [employeeId, minutes] of minutesByEmployee) {
    const line = lineFor(employees.get(employeeId)!, input.hoursWageType, "h", false);
    line.quantityHundredths = minutesToHundredthsOfHour(minutes);
  }

  for (const entry of input.pieceWork) {
    const employee = employeeOf(entry.employeeId, entry.id);
    if (!Number.isInteger(entry.rateCents) || entry.rateCents < 0) {
      throw new PayrollInputError(`piece work ${entry.id} has an invalid rate`);
    }
    const quantity = parseHundredths(entry.quantity);
    const line = lineFor(employee, entry.wageType, entry.unit, true);
    line.quantityHundredths += quantity;
    line.amountCents! += pieceAmountCents(quantity, entry.rateCents);
  }

  const sorted = [...lines.values()].sort((a, b) =>
    cmp(a.personnelNo, b.personnelNo) || cmp(a.wageType, b.wageType) || cmp(a.unit, b.unit)
  );

  return { lines: sorted, warnings: breakWarnings(input.timeEntries) };
}
