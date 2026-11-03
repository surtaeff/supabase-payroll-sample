import { assertEquals, assertMatch } from "@std/assert";
import { createHandler, type Deps, DomainError, mapDbError } from "../payroll-export/handler.ts";

const PERIOD_ID = "6f1c2a9e-4b7d-4c1e-9a2f-0d3b5e7a9c11";

/** In-memory fake that records calls, so tests can assert on side effects. */
function fakeDeps(overrides: Partial<Deps> = {}) {
  const calls: string[] = [];
  const uploads = new Map<string, string>();
  const deps: Deps = {
    getCaller: () => Promise.resolve({ employeeId: "e-office", role: "office" }),
    lockPeriod: () => {
      calls.push("lock");
      return Promise.resolve();
    },
    loadPeriodData: () =>
      Promise.resolve({
        startsOn: "2026-10-01",
        endsOn: "2026-10-31",
        employees: [{ id: "e-anna", personnelNo: "1002", fullName: "Anna Schäfer" }],
        timeEntries: [{
          id: "t1",
          employeeId: "e-anna",
          workDate: "2026-10-05",
          startedAt: "2026-10-05T07:00:00+02:00",
          endedAt: "2026-10-05T15:30:00+02:00",
          breakMinutes: 30,
        }],
        pieceWork: [],
      }),
    upload: (path, content) => {
      calls.push("upload");
      uploads.set(path, content);
      return Promise.resolve();
    },
    finalizeExport: ({ storagePath, sha256, lineCount }) => {
      calls.push("finalize");
      return Promise.resolve({ id: "x1", storagePath, sha256, lineCount });
    },
    ...overrides,
  };
  return { deps, calls, uploads };
}

function post(body: unknown, auth = "Bearer token"): Request {
  return new Request("http://localhost/payroll-export", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("happy path: lock, upload, finalize, in that order", async () => {
  const { deps, calls, uploads } = fakeDeps();
  const res = await createHandler(() => deps)(post({ period_id: PERIOD_ID }));

  assertEquals(res.status, 200);
  assertEquals(calls, ["lock", "upload", "finalize"]);
  const body = await res.json();
  assertEquals(body.export.lineCount, 1);
  assertMatch(body.export.storagePath, /^2026-10-01_2026-10-31\/[0-9a-f]{64}\.csv$/);
  assertEquals(body.warnings, []);
  assertEquals([...uploads.values()][0].split("\r\n")[1], "1002;Anna Schäfer;1000;8,00;h;");
});

Deno.test("a retry produces the same file path and checksum", async () => {
  const first = fakeDeps();
  const second = fakeDeps();
  const a = await (await createHandler(() => first.deps)(post({ period_id: PERIOD_ID }))).json();
  const b = await (await createHandler(() => second.deps)(post({ period_id: PERIOD_ID }))).json();
  assertEquals(a.export.storagePath, b.export.storagePath);
});

Deno.test("request validation", async (t) => {
  const handler = createHandler(() => fakeDeps().deps);

  await t.step("OPTIONS answers the CORS preflight", async () => {
    const res = await handler(new Request("http://localhost/", { method: "OPTIONS" }));
    assertEquals(res.status, 204);
  });
  await t.step("GET is not allowed", async () => {
    assertEquals((await handler(new Request("http://localhost/"))).status, 405);
  });
  await t.step("missing token is 401", async () => {
    assertEquals((await handler(post({ period_id: PERIOD_ID }, ""))).status, 401);
  });
  await t.step("broken JSON is 400", async () => {
    assertEquals((await handler(post("{nope"))).status, 400);
  });
  await t.step("period_id must be a uuid", async () => {
    assertEquals((await handler(post({ period_id: "1; drop table" }))).status, 400);
  });
});

Deno.test("unknown user is 401, technician is 403, nothing is locked", async () => {
  for (const [caller, status] of [[null, 401], [{ employeeId: "e1", role: "technician" }, 403]] as const) {
    const { deps, calls } = fakeDeps({ getCaller: () => Promise.resolve(caller) });
    const res = await createHandler(() => deps)(post({ period_id: PERIOD_ID }));
    assertEquals(res.status, status);
    assertEquals(calls, []);
  }
});

Deno.test("unapproved entries stop the export before anything is uploaded", async () => {
  const { deps, calls } = fakeDeps({
    lockPeriod: () => Promise.reject(mapDbError({ code: "PR002", message: "3 entries are not approved" })),
  });
  const res = await createHandler(() => deps)(post({ period_id: PERIOD_ID }));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "unapproved_entries");
  assertEquals(calls, []);
});

Deno.test("database error codes map to HTTP statuses", async () => {
  const cases: Array<[string, number]> = [["42501", 403], ["P0002", 404], ["PR001", 409]];
  for (const [code, status] of cases) {
    const { deps } = fakeDeps({ lockPeriod: () => Promise.reject(mapDbError({ code, message: code })) });
    assertEquals((await createHandler(() => deps)(post({ period_id: PERIOD_ID }))).status, status, code);
  }
});

Deno.test("unexpected failures are 500 without leaking details", async () => {
  const { deps } = fakeDeps({ upload: () => Promise.reject(new Error("bucket exploded: secret path")) });
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await createHandler(() => deps)(post({ period_id: PERIOD_ID }));
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { error: "internal_error" });
  } finally {
    console.error = originalError;
  }
});

Deno.test("inconsistent payroll data is 422", async () => {
  const { deps } = fakeDeps({
    loadPeriodData: () =>
      Promise.resolve({
        startsOn: "2026-10-01",
        endsOn: "2026-10-31",
        employees: [],
        timeEntries: [{
          id: "t1",
          employeeId: "e-ghost",
          workDate: "2026-10-05",
          startedAt: "2026-10-05T07:00:00Z",
          endedAt: "2026-10-05T08:00:00Z",
          breakMinutes: 0,
        }],
        pieceWork: [],
      }),
  });
  assertEquals((await createHandler(() => deps)(post({ period_id: PERIOD_ID }))).status, 422);
});

Deno.test("mapDbError keeps unknown errors generic", () => {
  assertEquals(mapDbError({ code: "PR002", message: "x" }) instanceof DomainError, true);
  assertEquals(mapDbError({ code: "23505", message: "dup" }) instanceof DomainError, false);
});
