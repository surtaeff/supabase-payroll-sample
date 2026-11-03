import { assertEquals, assertThrows } from "@std/assert";
import {
  breakWarnings,
  calculatePayroll,
  minutesToHundredthsOfHour,
  netMinutes,
  parseHundredths,
  PayrollInputError,
  pieceAmountCents,
  statutoryBreakMinutes,
  type TimeEntry,
} from "../_shared/payroll.ts";

const anna = { id: "e-anna", personnelNo: "1002", fullName: "Anna Schäfer" };
const ben = { id: "e-ben", personnelNo: "1001", fullName: "Ben Krüger" };

function shift(id: string, employeeId: string, start: string, end: string, breakMinutes = 0): TimeEntry {
  return {
    id,
    employeeId,
    workDate: start.slice(0, 10),
    startedAt: start,
    endedAt: end,
    breakMinutes,
  };
}

Deno.test("netMinutes subtracts the break", () => {
  assertEquals(
    netMinutes(shift("t1", "e", "2026-10-05T07:00:00+02:00", "2026-10-05T15:30:00+02:00", 30)),
    480,
  );
});

Deno.test("netMinutes counts real elapsed time across the DST switch", () => {
  // 25 Oct 2026: clocks go back at 03:00 CEST, so 00:00 to 06:00 local is 7 hours.
  assertEquals(netMinutes(shift("t1", "e", "2026-10-25T00:00:00+02:00", "2026-10-25T06:00:00+01:00")), 420);
});

Deno.test("netMinutes rejects entries without positive working time", () => {
  assertThrows(
    () => netMinutes(shift("t1", "e", "2026-10-05T07:00:00Z", "2026-10-05T07:30:00Z", 30)),
    PayrollInputError,
  );
  assertThrows(() => netMinutes(shift("t1", "e", "not a date", "2026-10-05T07:30:00Z")), PayrollInputError);
});

Deno.test("statutory break follows ArbZG section 4 thresholds", () => {
  assertEquals(statutoryBreakMinutes(360), 0); // exactly 6 h
  assertEquals(statutoryBreakMinutes(361), 30);
  assertEquals(statutoryBreakMinutes(540), 30); // exactly 9 h
  assertEquals(statutoryBreakMinutes(541), 45);
});

Deno.test("parseHundredths reads numeric strings without floats", () => {
  assertEquals(parseHundredths("12"), 1200);
  assertEquals(parseHundredths("12.5"), 1250);
  assertEquals(parseHundredths("0.05"), 5);
  for (const bad of ["", "1.234", "-1", "1e3", "1,5"]) {
    assertThrows(() => parseHundredths(bad), PayrollInputError, undefined, bad);
  }
});

Deno.test("rounding is half up", () => {
  assertEquals(minutesToHundredthsOfHour(1), 2); // 0.0166 h
  assertEquals(minutesToHundredthsOfHour(20), 33); // 0.333 h
  assertEquals(minutesToHundredthsOfHour(40), 67); // 0.666 h
  assertEquals(pieceAmountCents(150, 333), 500); // 1.50 x 3.33 = 4.995 -> 5.00
});

Deno.test("hours are summed before rounding, not per entry", () => {
  // Three entries of 20 minutes: per entry 0.33 + 0.33 + 0.33 = 0.99, correct is 1.00.
  const result = calculatePayroll({
    employees: [anna],
    timeEntries: [
      shift("t1", anna.id, "2026-10-05T08:00:00Z", "2026-10-05T08:20:00Z"),
      shift("t2", anna.id, "2026-10-06T08:00:00Z", "2026-10-06T08:20:00Z"),
      shift("t3", anna.id, "2026-10-07T08:00:00Z", "2026-10-07T08:20:00Z"),
    ],
    pieceWork: [],
    hoursWageType: "1000",
  });
  assertEquals(result.lines[0].quantityHundredths, 100);
});

Deno.test("piece work is priced per entry and grouped by wage type and unit", () => {
  const result = calculatePayroll({
    employees: [anna, ben],
    timeEntries: [shift("t1", anna.id, "2026-10-05T07:00:00Z", "2026-10-05T11:00:00Z")],
    pieceWork: [
      {
        id: "p1",
        employeeId: anna.id,
        workDate: "2026-10-05",
        quantity: "12.5",
        rateCents: 185,
        wageType: "2100",
        unit: "m",
      },
      {
        id: "p2",
        employeeId: anna.id,
        workDate: "2026-10-06",
        quantity: "3",
        rateCents: 185,
        wageType: "2100",
        unit: "m",
      },
      {
        id: "p3",
        employeeId: ben.id,
        workDate: "2026-10-05",
        quantity: "2",
        rateCents: 4500,
        wageType: "2200",
        unit: "pcs",
      },
    ],
    hoursWageType: "1000",
  });

  assertEquals(result.lines, [
    // sorted by personnel number, then wage type
    {
      personnelNo: "1001",
      fullName: "Ben Krüger",
      wageType: "2200",
      unit: "pcs",
      quantityHundredths: 200,
      amountCents: 9000,
    },
    {
      personnelNo: "1002",
      fullName: "Anna Schäfer",
      wageType: "1000",
      unit: "h",
      quantityHundredths: 400,
      amountCents: null,
    },
    // 12.50 x 1.85 = 23.125 -> 23.13, 3 x 1.85 = 5.55, total 28.68
    {
      personnelNo: "1002",
      fullName: "Anna Schäfer",
      wageType: "2100",
      unit: "m",
      quantityHundredths: 1550,
      amountCents: 2868,
    },
  ]);
});

Deno.test("entries of unknown employees are rejected, not dropped", () => {
  assertThrows(
    () =>
      calculatePayroll({
        employees: [anna],
        timeEntries: [shift("t9", "e-ghost", "2026-10-05T07:00:00Z", "2026-10-05T08:00:00Z")],
        pieceWork: [],
        hoursWageType: "1000",
      }),
    PayrollInputError,
    "unknown employee",
  );
});

Deno.test("output order does not depend on input order", () => {
  const entries = [
    shift("t1", anna.id, "2026-10-05T07:00:00Z", "2026-10-05T08:00:00Z"),
    shift("t2", ben.id, "2026-10-05T07:00:00Z", "2026-10-05T09:00:00Z"),
  ];
  const run = (timeEntries: TimeEntry[]) =>
    calculatePayroll({ employees: [anna, ben], timeEntries, pieceWork: [], hoursWageType: "1000" });
  assertEquals(run(entries), run([...entries].reverse()));
});

Deno.test("break warning when a long day has too little break", () => {
  const warnings = breakWarnings([
    shift("t1", anna.id, "2026-10-05T06:00:00Z", "2026-10-05T13:15:00Z", 15), // 7 h net, 15 min break
  ]);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].code, "BREAK_BELOW_STATUTORY_MINIMUM");
  assertEquals(warnings[0].message, "420 min worked with 15 min break, at least 30 min required");
});

Deno.test("gaps of 15 minutes or more between entries count as break", () => {
  const day = [
    shift("t1", anna.id, "2026-10-05T06:00:00Z", "2026-10-05T10:00:00Z"),
    shift("t2", anna.id, "2026-10-05T10:30:00Z", "2026-10-05T14:00:00Z"), // 30 min gap
  ];
  assertEquals(breakWarnings(day), []);

  const shortGap = [
    shift("t1", anna.id, "2026-10-05T06:00:00Z", "2026-10-05T10:00:00Z"),
    shift("t2", anna.id, "2026-10-05T10:10:00Z", "2026-10-05T14:00:00Z"), // 10 min gap does not count
  ];
  assertEquals(breakWarnings(shortGap).length, 1);
});

Deno.test("break rules apply per employee and day", () => {
  const warnings = breakWarnings([
    shift("t1", anna.id, "2026-10-05T06:00:00Z", "2026-10-05T11:00:00Z"), // 5 h
    shift("t2", anna.id, "2026-10-06T06:00:00Z", "2026-10-06T11:00:00Z"), // 5 h, next day
    shift("t3", ben.id, "2026-10-05T06:00:00Z", "2026-10-05T11:00:00Z"), // 5 h, other person
  ]);
  assertEquals(warnings, []);
});
