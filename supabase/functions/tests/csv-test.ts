import { assertEquals, assertThrows } from "@std/assert";
import { escapeField, formatHundredths, toPayrollCsv } from "../_shared/csv.ts";

Deno.test("formatHundredths uses a decimal comma", () => {
  assertEquals(formatHundredths(0), "0,00");
  assertEquals(formatHundredths(5), "0,05");
  assertEquals(formatHundredths(750), "7,50");
  assertEquals(formatHundredths(123456), "1234,56");
  assertThrows(() => formatHundredths(-1), RangeError);
  assertThrows(() => formatHundredths(1.5), RangeError);
});

Deno.test("escapeField quotes separators, quotes and line breaks", () => {
  assertEquals(escapeField("Müller"), "Müller");
  assertEquals(escapeField("Müller; Sohn"), '"Müller; Sohn"');
  assertEquals(escapeField('Max "Maxi" Mustermann'), '"Max ""Maxi"" Mustermann"');
  assertEquals(escapeField("a\nb"), '"a\nb"');
});

Deno.test("toPayrollCsv writes BOM, header, CRLF and empty amount for hour lines", () => {
  const csv = toPayrollCsv([
    {
      personnelNo: "1002",
      fullName: "Anna Schäfer",
      wageType: "1000",
      unit: "h",
      quantityHundredths: 400,
      amountCents: null,
    },
    {
      personnelNo: "1002",
      fullName: "Anna Schäfer",
      wageType: "2100",
      unit: "m",
      quantityHundredths: 1550,
      amountCents: 2868,
    },
  ]);
  assertEquals(
    csv,
    "\uFEFFpersonnel_no;name;wage_type;quantity;unit;amount_eur\r\n" +
      "1002;Anna Schäfer;1000;4,00;h;\r\n" +
      "1002;Anna Schäfer;2100;15,50;m;28,68\r\n",
  );
});
