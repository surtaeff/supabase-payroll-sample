import type { PayrollLine } from "./payroll.ts";

/**
 * Semicolon separated, decimal comma, CRLF line endings, UTF-8 with BOM:
 * the format German payroll tools and Excel open without an import wizard.
 */

const SEPARATOR = ";";
const NEWLINE = "\r\n";
const BOM = "\uFEFF";

export const HEADER = ["personnel_no", "name", "wage_type", "quantity", "unit", "amount_eur"];

/** 750 -> "7,50", 5 -> "0,05" */
export function formatHundredths(value: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`expected a non-negative integer, got ${value}`);
  }
  const whole = Math.floor(value / 100);
  const fraction = String(value % 100).padStart(2, "0");
  return `${whole},${fraction}`;
}

export function escapeField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toPayrollCsv(lines: PayrollLine[]): string {
  const rows = lines.map((line) => [
    line.personnelNo,
    line.fullName,
    line.wageType,
    formatHundredths(line.quantityHundredths),
    line.unit,
    line.amountCents === null ? "" : formatHundredths(line.amountCents),
  ]);
  return BOM + [HEADER, ...rows]
    .map((row) => row.map(escapeField).join(SEPARATOR))
    .join(NEWLINE) +
    NEWLINE;
}
