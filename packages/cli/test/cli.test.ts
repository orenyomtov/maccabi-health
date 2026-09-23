import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ISSUES_URL, ReadOperationError, ReauthenticationRequired, UpstreamError, type MaccabiSession, type PendingLogin } from "@maccabi/core";
import { runCli, type CliDependencies, type Connected } from "../src/cli";
import { configDirectory, FilePendingLoginStore, FileSessionStore, SessionStoreError, type SavedLogin } from "../src/store";

const session: MaccabiSession = {
  version: 1, authenticatedAt: "2026-01-01T00:00:00.000Z",
  cookies: { version: "tough-cookie@6.0.2", storeType: "MemoryCookieStore", rejectPublicSuffixes: true, cookies: [] },
  apiAuthorization: "Bearer synthetic.session.token",
};
const owner = { memberId: 12345678, memberIdCode: "0" };
const saved: SavedLogin = { session, owner };
const challenge = (): PendingLogin => ({
  version: 1, id: "synthetic-challenge", memberId: owner.memberId, senderJwt: "synthetic.sender.jwt", validatorJwt: "synthetic.validator.jwt",
  phones: [{ index: 0, label: "Phone ending 12", display: "ending 12", smsAvailable: true }], expiresAt: Date.now() + 600_000,
  cookies: { version: "tough-cookie@6.0.2", storeType: "MemoryCookieStore", rejectPublicSuffixes: true, cookies: [] },
});
function fixture(initial: SavedLogin | null = saved, initialPending: PendingLogin | null = null) {
  let stored = initial;
  let pending = initialPending;
  let output = "", error = "";
  const calls: string[] = [];
  const prompts: { label: string; hidden: boolean }[] = [];
  const input = ["012345678", "123456"];
  const readers = {
    currentOwner: owner,
    getOwnerProfile: () => ({ data: { f_name_hebrew: "דוגמה", member_id: owner.memberId }, source: { operation: "account" } }),
    listPrescriptions: async () => { calls.push("prescriptions"); return { data: [{ drug_name: "תרופה סינתטית" }] }; },
    getReferralPdf: async () => { calls.push("pdf"); return { data: new TextEncoder().encode("%PDF-synthetic") }; },
    getLabResult: async () => { calls.push("lab-detail"); return { data: { results: [], is_partial: false } }; },
    listTests: async (options?: { year?: number }) => { expect(options).toEqual({ year: 2025 }); calls.push("labs-year"); return { data: { tests: [], categories: [] }, source: { completeness: "local-filtered-subset" } }; },
  } as unknown as Connected["readers"];
  let clock = 0;
  const phones = [{ index: 0, label: "Phone ending 12", display: "ending 12", smsAvailable: true }];
  const smsPhones: (number | undefined)[] = [];
  const deps: CliDependencies = {
    now: () => clock, wait: async milliseconds => { clock += milliseconds; },
    isInteractive: () => true,
    env: {},
    store: {
      load: async () => { calls.push("load"); return stored; },
      save: async value => { calls.push("save"); stored = value; },
      delete: async () => { calls.push("delete"); stored = null; },
    },
    pending: {
      load: async () => { calls.push("load-pending"); return pending; },
      save: async value => { calls.push("save-pending"); pending = value; },
      delete: async () => { calls.push("delete-pending"); pending = null; },
    },
    prompt: async (label, hidden = false) => { prompts.push({ label, hidden }); return input.shift()!; },
    connect: async (_session, expected) => { expect(expected).toEqual(owner); calls.push("connect"); return { readers, exportSession: async () => session }; },
    createAuth: () => ({
      beginLogin: async () => { calls.push("begin"); return { id: "synthetic-challenge", phones: [...phones] }; },
      requestOtp: async (_id, phoneIndex) => { calls.push("send-sms"); smsPhones.push(phoneIndex); },
      completeLogin: async () => { calls.push("verify-otp"); return session; },
      exportPending: async () => { calls.push("export-pending"); return { ...challenge(), phones: [...phones] }; },
      restorePending: () => { calls.push("restore-pending"); },
      cancelLogin: async () => { calls.push("cancel"); },
    }),
    stdout: text => { output += text; }, stderr: text => { error += text; },
    savePdf: async (_path, bytes) => { expect(new TextDecoder().decode(bytes)).toBe("%PDF-synthetic"); calls.push("save-pdf"); },
  };
  return { deps, calls, phones, smsPhones, prompts, output: () => output, error: () => error, stored: () => stored, pending: () => pending };
}

describe("CLI dispatch", () => {
  test("offline help, focused discovery and version never access credentials or upstream", async () => {
    for (const argv of [["help", "--json"], ["help", "labs", "--json"], ["labs", "--help", "--json"], ["version", "--json"], ["--version"], ["login", "-h"]]) {
      const f = fixture();
      expect(await runCli(argv, f.deps)).toBe(0);
      expect(f.calls).toEqual([]);
      expect(f.prompts).toEqual([]);
      expect(f.error()).toBe("");
      if (argv.includes("--json")) expect(JSON.parse(f.output()).version).toBe("0.1.0");
      if (argv.includes("labs")) expect(JSON.parse(f.output()).commands.map((c: { name: string }) => c.name)).toEqual(["labs"]);
      if (argv[0] === "help" && argv.length === 2) {
        expect(JSON.parse(f.output()).notImplemented).toContain("booking");
        expect(JSON.parse(f.output()).limitations.join(" ")).toContain("Clinical history retention and upstream paging are incomplete");
      }
    }
  });

  test("a caveat shared by a family of commands is written once and still reachable from each of them", async () => {
    const text = fixture();
    expect(await runCli(["help"], text.deps)).toBe(0);
    const printed = text.output();
    // The whole imaging paragraph used to be pasted onto four commands. One copy, four pointers.
    const marker = "eight-hop chain";
    expect(printed.split(marker).length - 1).toBe(1);
    expect(printed).toContain("Topics (each applies to every command that names it above)");
    for (const command of ["imaging-study", "imaging-image", "imaging-thumbnail", "imaging-pixels"]) {
      const block = printed.slice(printed.indexOf(`maccabi ${command} `));
      expect(block.slice(0, block.indexOf("\n  maccabi "))).toContain("See also: imaging-viewer");
    }
    const json = fixture();
    expect(await runCli(["help", "imaging-pixels", "--json"], json.deps)).toBe(0);
    const discovery = JSON.parse(json.output());
    expect(discovery.commands[0].topics).toEqual(["imaging-viewer", "private-files"]);
    // A machine reader gets the text too, not just the label, so nothing is lost by not repeating it.
    expect(discovery.topics["imaging-viewer"]).toContain(marker);
    expect(discovery.topics["private-files"]).toContain("0600");
  });

  test("the bare invocation stays a small index and routes to the detail instead of printing it", async () => {
    // Bare `maccabi` is the first thing an unprimed agent types. It used to print the whole catalog,
    // ~30 KB, which is more context than connecting the MCP server costs. If this cap ever fails,
    // shorten the summaries - do not raise the number. The full catalog lives under `maccabi help`.
    const LIMIT = 6_000;
    for (const argv of [[], ["--help"], ["-h"], ["--json"], ["--help", "--json"]]) {
      const f = fixture();
      expect(await runCli(argv, f.deps)).toBe(0);
      expect(f.calls).toEqual([]);
      expect(f.prompts).toEqual([]);
      expect(f.error()).toBe("");
      expect(f.output().length).toBeLessThan(LIMIT);
    }
    const text = fixture();
    expect(await runCli([], text.deps)).toBe(0);
    const printed = text.output();
    expect(printed).toContain("maccabi help COMMAND");
    expect(printed).toContain("maccabi login");
    // Every command reachable from the full help is named here, so the index hides nothing.
    const full = fixture();
    expect(await runCli(["help", "--json"], full.deps)).toBe(0);
    const names = JSON.parse(full.output()).commands.map((c: { name: string }) => c.name);
    for (const name of names) expect(printed).toContain(`\n  ${name} `);
    expect(full.output().length).toBeGreaterThan(printed.length * 4);

    const json = fixture();
    expect(await runCli(["--json"], json.deps)).toBe(0);
    const machine = JSON.parse(json.output());
    expect(machine.commands.map((c: { name: string }) => c.name).sort()).toEqual([...names].sort());
    expect(machine.commands.every((c: { summary: string }) => c.summary.length > 0 && c.summary.length <= 48)).toBe(true);
    expect(machine.detail).toContain("maccabi help COMMAND --json");
    // The index is a router, not a reference: no command's usage string or caveats belong in it.
    expect(printed).not.toContain("--out FILE");
    expect(json.output()).not.toContain("eight-hop chain");
  });

  test("mcp stays a discoverable help topic although it is dispatched before CLI parsing", async () => {
    const all = fixture();
    expect(await runCli(["help", "--json"], all.deps)).toBe(0);
    expect(JSON.parse(all.output()).commands.map((c: { name: string }) => c.name)).toContain("mcp");
    const focused = fixture();
    expect(await runCli(["help", "mcp", "--json"], focused.deps)).toBe(0);
    expect(JSON.parse(focused.output()).commands.map((c: { name: string }) => c.name)).toEqual(["mcp"]);
    expect(focused.calls).toEqual([]);
  });

  test("noninteractive login refuses before credential storage, prompts or SMS", async () => {
    for (const tty of [true, false]) {
      const f = fixture(null);
      f.deps.isInteractive = () => tty;
      expect(await runCli(tty ? ["login", "--no-input"] : ["login"], f.deps)).toBe(3);
      expect(f.calls).toEqual([]);
      expect(f.prompts).toEqual([]);
      expect(f.output()).toBe("");
      expect(f.error()).toContain("interactive terminal");
    }
  });

  test("missing session has actionable structured stderr and empty stdout, never prompts", async () => {
    const f = fixture(null);
    expect(await runCli(["prescriptions", "--json", "--no-input"], f.deps)).toBe(3);
    const reported = JSON.parse(f.error()).error;
    expect(reported).toMatchObject({ code: "AUTH_REQUIRED", exitCode: 3 });
    expect(reported.message).toContain("maccabi login --id <id>");
    expect(reported.message).toContain("maccabi login --code <code>");
    expect(f.output()).toBe("");
    expect(f.calls).toEqual(["load"]);
    expect(f.prompts).toEqual([]);
  });

  test("usage errors in JSON mode do not echo invalid values", async () => {
    for (const argv of [["labs", "--request", "synthetic-secret", "--json"], ["synthetic-secret", "--json"], ["login", "--otp", "synthetic-secret", "--json"]]) {
      const f = fixture();
      expect(await runCli(argv, f.deps)).toBe(2);
      expect(JSON.parse(f.error()).error.code).toBe("INVALID_USAGE");
      expect(f.error()).not.toContain("synthetic-secret");
      expect(f.output()).toBe("");
      expect(f.calls).toEqual([]);
    }
  });

  test("invalid dates, years, required references and local page options fail before storage", async () => {
    for (const argv of [
      ["referrals", "--from", "2026-02-30", "--to", "2026-03-01"],
      ["referrals", "--from", "2026-03-02", "--to", "2026-03-01"],
      ["provider", "--at", "2026-02-30T00:00:00"], ["provider", "--at", "2026-03-01T25:00:00"],
      ["labs", "--year", "0000"], ["provider-details", "--object-type", "X"],
      ["prescriptions", "--limit", "0"], ["prescriptions", "--limit", "1001"],
      ["prescriptions", "--limit", "1", "--offset", "-1"], ["prescriptions", "--offset", "1"],
      ["visits", "--id", "test", "--limit", "1"], ["labs", "--request", "test", "--doc", "test", "--limit", "1"],
      ["vaccination-pdf"], ["english-summary-pdf"], ["medication-report-pdf"], ["inquiries", "--id", "test", "--limit", "1"],
      ["vaccinations", "--group", "-1"], ["vaccinations", "--group", "1.5"], ["vaccinations", "--group", "9007199254740992"],
      ["notifications"], ["notifications", "--from", "2026-02-30", "--to", "2026-03-01"],
      ["billing-reports", "--period", "malformed"], ["billing-reports", "--period", "12345"],
      ["keep-alive"], ["keep-alive", "--interval", "59", "--duration", "120"], ["keep-alive", "--interval", "60", "--duration", "0"], ["keep-alive", "--interval", "60", "--duration", "86401"],
      ["billing-report-pdf", "--reference", "a".repeat(64), "--out", "synthetic.pdf"], ["billing-report-pdf", "--reference", "malformed", "--period", "1001", "--out", "synthetic.pdf"], ["billing-report-pdf", "--reference", "a".repeat(64), "--period", "display-label", "--out", "synthetic.pdf"],
      ["inquiry-document-pdf", "--reference", "a".repeat(64), "--out", "synthetic.pdf"],
      ["visit-pdf"], ["visit-pdf", "--id", "synthetic-visit"], ["inquiry-document-pdf", "--id", "synthetic-inquiry", "--out", "synthetic.pdf"], ["inquiry-document-pdf", "--id", "synthetic-inquiry", "--reference", "malformed", "--out", "synthetic.pdf"],
      ["prescription-pdf"], ["sensitivity-pdf"], ["notification-pdf"], ["additional-information-pdf"], ["lab-file-pdf", "--request", "synthetic", "--doc", "synthetic", "--out", "synthetic.pdf"],
      ...["notification-pdf", "additional-information-pdf"].flatMap(command => [[command, "--reference", "malformed", "--from", "2026-01-01", "--to", "2026-12-31", "--out", "synthetic.pdf"], [command, "--reference", "a".repeat(64), "--from", "2026-12-31", "--to", "2026-01-01", "--out", "synthetic.pdf"]]),
      ["hospital-pdf", "--reference", "malformed", "--as-of", "2026-09-20", "--out", "synthetic.pdf"],
      ["english-covid-lab-report-pdf", "--request", "synthetic", "--doc", "synthetic"],
      ["english-covid-lab-report-pdf", "--request", "synthetic", "--doc", "synthetic", "--out", "synthetic.pdf", "--passport", "forbidden"],
      ["lab-comparison-pdf", "--source", "latest", "--test", "synthetic", "--view", "invented", "--out", "synthetic.pdf"],
      ["lab-comparison-pdf", "--source", "latest", "--test", "synthetic", "--request", "forbidden", "--doc", "forbidden", "--view", "graph", "--out", "synthetic.pdf"],
      ["certificate-pdf", "--reference", "malformed", "--from", "2026-01-01", "--to", "2026-12-31", "--out", "synthetic.pdf"],
      ["hospital-pdf"], ["hospital-pdf", "--reference", "synthetic", "--as-of", "2026-02-30", "--out", "synthetic.pdf"], ["hospital-pdf", "--as-of", "2026-01-01", "--out", "synthetic.pdf"],
      ["hospital-history"], ["hospital-history", "--as-of", "2026-02-30"],
      ["certificates"], ["certificates", "--from", "2026-01-01"],
      ["additional-information"], ["additional-information", "--from", "2026-01-01", "--to", "2026-02-30"],
      ["certificate-pdf", "--from", "2026-01-01", "--to", "2026-12-31", "--out", "synthetic.pdf"],
      ["imaging-pdf", "--out", "synthetic.pdf"], ["imaging-pdf", "--request", "synthetic", "--doc", "synthetic"],
    ]) {
      const f = fixture();
      expect(await runCli(argv, f.deps)).toBe(2);
      expect(f.calls).toEqual([]);
    }
  });

  test("local pages preserve complete selected records and provenance without claiming history completeness", async () => {
    const f = fixture();
    const source = { operation: "prescriptions", completeness: "upstream-response" };
    const records = [{ drug_name: "תרופה א", instructions: "טקסט מלא", extra: { untouched: true } }, { drug_name: "תרופה ב", instructions: "המשך" }, { drug_name: "תרופה ג" }];
    f.deps.connect = async () => ({ readers: { listPrescriptions: async () => ({ data: records, source }), currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["prescriptions", "--limit", "1", "--offset", "1", "--json"], f.deps)).toBe(0);
    const result = JSON.parse(f.output());
    expect(result.data).toEqual([records[1]]);
    expect(result.source).toEqual(source);
    expect(result.page).toEqual({ mode: "local", offset: 1, limit: 1, returned: 1, availableInResponse: 3, hasMoreInResponse: true, upstreamTotalKnown: false });
    expect(records).toHaveLength(3);
  });

  test("local lab pages preserve categories and year-selection provenance, including empty pages", async () => {
    const f = fixture();
    const result = { data: { categories: [{ code: "synthetic" }], tests: [{ doc_id: "a" }, { doc_id: "b" }] }, source: { completeness: "local-filtered-subset", selection: { mode: "local", field: "execute_date", year: 2025 } } };
    f.deps.connect = async () => ({ readers: { listTests: async () => result, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["labs", "--year", "2025", "--limit", "1", "--offset", "10", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual({ categories: result.data.categories, tests: [] });
    expect(JSON.parse(f.output()).source).toEqual(result.source);
    expect(JSON.parse(f.output()).page.hasMoreInResponse).toBe(false);
    expect(JSON.parse(f.output()).page.upstreamTotalKnown).toBe(false);
  });

  test("printed results drop identity, credential and private-path fields while keeping has_document", async () => {
    const f = fixture();
    const row = {
      request_id: "synthetic-request", doc_id: "synthetic-document", type: "imaging_result", has_document: true,
      test_name: ["בדיקה לדוגמה"], member_id: "123456789", member_id_code: 0, hash: "synthetic-signature",
      result_files: [{ result_file: "synthetic/attachment/path" }], pdf_link: "/synthetic/private/link",
    };
    const result = { data: { categories: [], tests: [row] }, source: { operation: "tests" } };
    f.deps.connect = async () => ({ readers: { listTests: async () => result, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["labs", "--json"], f.deps)).toBe(0);
    const printed = f.output();
    for (const omitted of ["result_files", "result_file", "pdf_link", "member_id", "hash", "synthetic/attachment/path", "synthetic/private/link", "synthetic-signature"]) expect(printed).not.toContain(omitted);
    expect(JSON.parse(printed).data.tests).toEqual([{ request_id: row.request_id, doc_id: row.doc_id, type: row.type, has_document: true, test_name: row.test_name }]);
  });

  test("vaccination group output preserves source records and supports explicit local selection", async () => {
    const f = fixture();
    const groups = [{ vaccine_group_code: 1, vaccinations_amount: 2, vaccine_group_name: "חיסון סינתטי", first_date: "2020-01-01", last_date: "2025-01-01", timestamp: "synthetic-timestamp" }];
    f.deps.connect = async () => ({ readers: { listVaccinationGroups: async () => ({ data: groups, source: { operation: "vaccination-groups" } }), currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["vaccinations", "--limit", "1", "--json", "--no-input"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual(groups);
    expect(JSON.parse(f.output()).source.operation).toBe("vaccination-groups");
    expect(JSON.parse(f.output()).page.upstreamTotalKnown).toBe(false);
    expect(f.error()).toBe("");
  });

  test("empty sensitivity response is preserved without inventing allergy interpretation", async () => {
    const f = fixture();
    const result = { data: [], source: { operation: "sensitivities", completeness: "upstream-response" } };
    f.deps.connect = async () => ({ readers: { listSensitivities: async () => result, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["sensitivities", "--json", "--no-input"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual(result);
    expect(f.error()).toBe("");
    expect(f.prompts).toEqual([]);
  });

  test("unknown sensitivity shapes report an explicit failure rather than an empty list", async () => {
    const f = fixture();
    f.deps.connect = async () => ({ readers: { listSensitivities: async () => { throw new ReadOperationError("UNSUPPORTED_FLOW", "sensitivities"); }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["sensitivities", "--json"], f.deps)).toBe(1);
    expect(JSON.parse(f.error()).error.code).toBe("UNSUPPORTED_FLOW");
    expect(f.output()).toBe("");
    expect(f.stored()).toEqual(saved);
  });

  test("frontend-derived sensitivity records retain clinical text, nulls and schema evidence", async () => {
    const f = fixture();
    const result = { data: [{ registration_date: "2025-01-01", sensitivity: "רגישות סינתטית", practitioner_name: "דוגמה", speciality: null, sensitivity_presentation: "תיאור מקורי", classification: 1 }], source: { operation: "sensitivities", completeness: "upstream-response", schemaEvidence: "frontend-field-projection" } };
    f.deps.connect = async () => ({ readers: { listSensitivities: async () => result, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["sensitivities", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual(result);
    expect(f.error()).toBe("");
  });

  test("vaccination PDF uses the private file adapter and never emits bytes to stdout", async () => {
    const f = fixture();
    f.deps.connect = async () => ({ readers: { getVaccinationCertificatePdf: async () => ({ data: new TextEncoder().encode("%PDF-synthetic") }), currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["vaccination-pdf", "--out", "synthetic-certificate.pdf", "--json"], f.deps)).toBe(0);
    expect(f.calls).toContain("save-pdf");
    expect(JSON.parse(f.output())).toEqual({ status: "saved", bytes: 14 });
    expect(f.output()).not.toContain("%PDF");
  });

  test("English summary preserves original PDF bytes without any identity-update operation", async () => {
    const f = fixture();
    f.deps.connect = async () => ({ readers: { getEnglishMedicalSummaryPdf: async () => { f.calls.push("english-summary-pdf"); return { data: new TextEncoder().encode("%PDF-synthetic") }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["english-summary-pdf", "--out", "synthetic-summary.pdf", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual(["load", "english-summary-pdf", "save-pdf", "save"]);
    expect(JSON.parse(f.output())).toEqual({ status: "saved", bytes: 14 });
    expect(f.output()).not.toContain("%PDF");
  });

  test("purchased-medication PDF uses the observed report reader and preserves bytes", async () => {
    const f = fixture();
    f.deps.connect = async () => ({ readers: { getMedicationReportPdf: async () => { f.calls.push("medication-report-pdf"); return { data: new TextEncoder().encode("%PDF-synthetic") }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["medication-report-pdf", "--out", "synthetic-medications.pdf", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual(["load", "medication-report-pdf", "save-pdf", "save"]);
    expect(JSON.parse(f.output())).toEqual({ status: "saved", bytes: 14 });
    expect(f.output()).not.toContain("%PDF");
  });

  test("certificate list preserves clinical labels and path-derived local references with explicit date bounds", async () => {
    const f = fixture();
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const rows = [{ reference: "a".repeat(64), title_name: "אישור סינתטי", practitioner_full_name: "דוגמה", specialization_description: "מקור", approval_date: "2026-01-02", approval_date_from: "2026-01-02", approval_date_to: "2026-01-03", approval_type_code: "synthetic" }];
    f.deps.connect = async () => ({ readers: { listCertificates: async (selectedRange: unknown) => { expect(selectedRange).toEqual(range); return { data: rows, source: { operation: "certificates" } }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["certificates", "--from", range.from, "--to", range.to, "--limit", "1", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual(rows);
    expect(JSON.parse(f.output()).page.upstreamTotalKnown).toBe(false);
  });

  test("quarterly billing catalog preserves period options, original labels and initial-page counts", async () => {
    const periods = [{ value: "1001", label: "תקופה א" }, { value: "1002", label: "תקופה ב" }];
    const original = { data: { availablePeriods: periods, selectedPeriod: periods[1], reports: [{ period: "תקופה ב", productionDate: "2026-01-02", viewLabel: "צפייה בדוח סינתטי", reference: "a".repeat(64) }], pagination: { returned: 1, reportedResultCount: 3, totalPages: 3, currentPage: 1 } }, source: { service: "synthetic", operation: "quarterly-billing-reports" } };
    for (const period of [undefined, periods[1]!.value]) {
      const f = fixture();
      f.deps.connect = async () => ({ readers: { listQuarterlyBillingReports: async (requested: unknown) => { expect(requested).toBe(period); return original; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
      expect(await runCli(["billing-reports", ...(period ? ["--period", period] : []), "--json"], f.deps)).toBe(0);
      expect(JSON.parse(f.output())).toEqual(original);
    }
    const invalid = fixture();
    expect(await runCli(["billing-reports", "--period", "synthetic", "--limit", "1", "--json"], invalid.deps)).toBe(2);
    expect(invalid.calls).toEqual([]);
  });

  test("one-shot session renewal uses the shared reader and persists updated cookies", async () => {
    const f = fixture();
    const original = { data: { renewed: true }, source: { service: "MainAppAPI", operation: "session-renewal" } };
    f.deps.connect = async () => ({ readers: { renewSession: async () => { f.calls.push("renew"); return original; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["renew-session", "--json", "--no-input"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual(original);
    expect(f.calls).toEqual(["load", "renew", "save"]);
    expect(f.prompts).toEqual([]);
  });
  test("nursing catalogs, common administrative detail and prescription alternatives preserve source coverage", async () => {
    const catalog = { reports: [{ period: "2025", productionDate: "2026-01-01", viewLabel: "צפייה", reference: "a".repeat(64) }], pagination: { returned: 1, reportedResultCount: 1, totalPages: 1, currentPage: 1 } };
    const detail = { classification: "Case", coverage: "common", body: "טקסט מקור", messages: [], attachments: [{ file_name: null, reference: "a".repeat(64) }], obligation_details: { treatments: [{ treatment_name: "מקור" }] }, decision: { kind: "refund", print_decision_message: "טקסט מקור" }, unsupported_sections: ["extended_properties"] };
    for (const [argv, method, expected, data] of [
      [["nursing-insurance-reports"], "listNursingInsuranceReports", [], catalog],
      [["administrative-requests", "--id", "synthetic"], "getAdministrativeRequest", ["synthetic"], detail],
      [["prescription-alternatives", "--id", "synthetic"], "listPrescriptionAlternatives", ["synthetic"], [{ largo_code: 123, name: "מקור" }]],
    ] as const) {
      const f = fixture();
      const original = { data, source: { operation: method, schemaEvidence: "frontend-field-projection" } };
      f.deps.connect = async () => ({ readers: { [method]: async (...args: unknown[]) => { expect(args).toEqual(expected); return original; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
      expect(await runCli([...argv, "--json"], f.deps)).toBe(0);
      expect(JSON.parse(f.output())).toEqual(original);
    }
    for (const argv of [["prescription-alternatives"], ["administrative-requests", "--id", "synthetic", "--limit", "1"], ["administrative-request-pdf", "--id", "synthetic", "--reference", "malformed", "--out", "synthetic.pdf"], ["nursing-insurance-report-pdf", "--reference", "malformed", "--out", "synthetic.pdf"], ["nursing-insurance-reports", "--period", "2025"], ["lab-report-pdf", "--request", "r", "--doc", "d"]]) {
      const f = fixture();
      expect(await runCli([...argv, "--json"], f.deps)).toBe(2); expect(f.calls).toEqual([]);
    }
  });

  test("finite keep-alive persists each renewal and never issues a call at or after its deadline", async () => {
    const f = fixture(); let clock = 0;
    const times: number[] = [], waits: number[] = [];
    f.deps.now = () => clock;
    f.deps.wait = async milliseconds => { waits.push(milliseconds); clock += milliseconds; };
    f.deps.connect = async () => ({ readers: { renewSession: async () => { times.push(clock); return { data: { renewed: true } }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    expect(await runCli(["keep-alive", "--interval", "60", "--duration", "125", "--json"], f.deps)).toBe(0);
    expect(times).toEqual([0, 60000, 120000]);
    expect(waits).toEqual([60000, 60000, 5000]);
    expect(f.calls).toEqual(["load", "save", "save", "save"]);
    expect(JSON.parse(f.output())).toEqual({ status: "completed", renewals: 3, elapsedSeconds: 125 });
    expect(f.error()).toBe("");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  test("keep-alive interruption aborts waiting and removes signal handlers without another renewal", async () => {
    const f = fixture(); const cancellation = new AbortController(); let renewals = 0;
    f.deps.signal = cancellation.signal;
    f.deps.wait = async (_milliseconds, signal) => { cancellation.abort(); expect(signal.aborted).toBe(true); throw new DOMException("Cancelled", "AbortError"); };
    f.deps.connect = async () => ({ readers: { renewSession: async () => { renewals++; return { data: { renewed: true } }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    expect(await runCli(["keep-alive", "--interval", "60", "--duration", "600", "--json"], f.deps)).toBe(0);
    expect(renewals).toBe(1);
    expect(JSON.parse(f.output())).toEqual({ status: "cancelled", renewals: 1, elapsedSeconds: 0 });
    expect(f.calls).toEqual(["load", "save"]);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  test("keep-alive stops on reauthentication or storage failure without retries, SMS or partial stdout", async () => {
    for (const failure of ["reauth", "storage"] as const) {
      const f = fixture(); let renewals = 0;
      f.deps.connect = async () => ({ readers: { renewSession: async () => { if (++renewals === 2) throw new ReauthenticationRequired(401); return { data: { renewed: true } }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
      if (failure === "storage") f.deps.store.save = async () => { throw new SessionStoreError(); };
      expect(await runCli(["keep-alive", "--interval", "60", "--duration", "600", "--json"], f.deps)).toBe(failure === "reauth" ? 3 : 1);
      expect(renewals).toBe(failure === "reauth" ? 2 : 1);
      expect(JSON.parse(f.error()).error.code).toBe(failure === "reauth" ? "AUTH_REQUIRED" : "SESSION_STORE_UNAVAILABLE");
      expect(f.output()).toBe("");
      expect(f.prompts).toEqual([]);
      expect(f.calls).toEqual(failure === "reauth" ? ["load", "save", "delete"] : ["load"]);
    }
  });

  test("source-backed PDF commands forward exact owner-list references and preserve original private bytes", async () => {
    const reference = "a".repeat(64);
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const cases = [
      { command: "latest-labs-pdf", method: "getLatestLabResultsPdf", flags: [], expected: [] },
      { command: "latest-labs-pdf", method: "getLatestLabResultsPdf", flags: ["--irregular-only"], expected: [{ irregularOnly: true }] },
      { command: "nursing-insurance-report-pdf", method: "getNursingInsuranceReportPdf", flags: ["--reference", reference], expected: [reference] },
      { command: "administrative-request-pdf", method: "getAdministrativeRequestPdf", flags: ["--id", "synthetic", "--reference", reference], expected: ["synthetic", reference] },
      { command: "lab-report-pdf", method: "getLabReportPdf", flags: ["--request", "synthetic-request", "--doc", "synthetic-doc"], expected: ["synthetic-request", "synthetic-doc"] },
      { command: "lab-report-pdf", method: "getLabReportPdf", flags: ["--request", "synthetic-request", "--doc", "synthetic-doc", "--irregular-only"], expected: ["synthetic-request", "synthetic-doc", { irregularOnly: true }] },
      { command: "english-covid-lab-report-pdf", method: "getEnglishCovidLabReportPdf", flags: ["--request", "synthetic-request", "--doc", "synthetic-doc"], expected: ["synthetic-request", "synthetic-doc"] },
      { command: "followed-labs-pdf", method: "getFollowedLabResultsPdf", flags: [], expected: [] },
      { command: "lab-comparison-pdf", method: "getLabComparisonPdf", flags: ["--source", "result", "--request", "synthetic-request", "--doc", "synthetic-doc", "--test", "synthetic-test"], expected: [{ source: "result", requestId: "synthetic-request", docId: "synthetic-doc", testId: "synthetic-test" }] },
      { command: "lab-comparison-pdf", method: "getLabComparisonPdf", flags: ["--source", "latest", "--test", "synthetic-test", "--view", "graph"], expected: [{ source: "latest", testId: "synthetic-test" }, "graph"] },
      { command: "billing-report-pdf", method: "getQuarterlyBillingReportPdf", flags: ["--reference", reference, "--period", "1001"], expected: [reference, "1001"] },
      { command: "visit-pdf", method: "getVisitSummaryPdf", flags: ["--id", "synthetic-visit"], expected: ["synthetic-visit"] },
      { command: "visit-document-pdf", method: "getVisitDocumentPdf", flags: ["--id", "synthetic-visit", "--reference", reference], expected: ["synthetic-visit", reference] },
      { command: "inquiry-document-pdf", method: "getInquiryDocumentPdf", flags: ["--id", "synthetic-inquiry", "--reference", reference], expected: ["synthetic-inquiry", reference] },
      { command: "prescription-pdf", method: "getPrescriptionPdf", flags: ["--id", "synthetic-doc"], expected: ["synthetic-doc"] },
      { command: "sensitivity-pdf", method: "getSensitivityPdf", flags: [], expected: [] },
      { command: "notification-pdf", method: "getNotificationPdf", flags: ["--reference", reference, "--from", range.from, "--to", range.to], expected: [reference, range] },
      { command: "additional-information-pdf", method: "getAdditionalInformationPdf", flags: ["--reference", reference, "--from", range.from, "--to", range.to], expected: [reference, range] },
      { command: "lab-file-pdf", method: "getLabResultFilePdf", flags: ["--request", "synthetic-request", "--doc", "synthetic-doc", "--test", "synthetic-test"], expected: [{ source: "result", requestId: "synthetic-request", docId: "synthetic-doc", testId: "synthetic-test" }] },
    ];
    for (const item of cases) {
      const f = fixture();
      f.deps.connect = async () => ({ readers: { [item.method]: async (...args: unknown[]) => { expect(args).toEqual(item.expected); return { data: new TextEncoder().encode("%PDF-synthetic") }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
      expect(await runCli([item.command, ...item.flags, "--out", "synthetic.pdf", "--json"], f.deps)).toBe(0);
      expect(f.calls).toContain("save-pdf");
      expect(JSON.parse(f.output())).toEqual({ status: "saved", bytes: 14 });
      expect(f.output()).not.toContain("%PDF");
    }
  });

  test("hospital PDF forwards only the owner-list reference and same as-of date to private output", async () => {
    const f = fixture();
    f.deps.connect = async () => ({ readers: { getHospitalReportPdf: async (reference: string, asOf: string) => { expect(reference).toBe("a".repeat(64)); expect(asOf).toBe("2026-09-20"); return { data: new TextEncoder().encode("%PDF-synthetic") }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["hospital-pdf", "--reference", "a".repeat(64), "--as-of", "2026-09-20", "--out", "synthetic-hospital.pdf", "--json"], f.deps)).toBe(0);
    expect(f.calls).toContain("save-pdf");
    expect(JSON.parse(f.output())).toEqual({ status: "saved", bytes: 14 });
    expect(f.output()).not.toContain("%PDF");
  });

  test("visit document references are discoverable and malformed download inputs fail before storage", async () => {
    const reference = "a".repeat(64);
    const f = fixture();
    const data = { drugs: [{ pdf_reference: reference, drug_name: "תרופה סינתטית" }] };
    f.deps.connect = async () => ({ readers: { getVisit: async () => ({ data }), currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["visits", "--id", "synthetic-visit", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual(data);
    for (const flags of [["--reference", "malformed"], [], ["--reference", reference, "--path", "/never-used"]]) {
      const invalid = fixture();
      expect(await runCli(["visit-document-pdf", "--id", "synthetic-visit", ...flags, "--out", "synthetic.pdf", "--json"], invalid.deps)).toBe(2);
      expect(invalid.calls).toEqual([]);
      expect(invalid.output()).toBe("");
    }
  });

  test("latest labs preserve groups and comparison uses only owner-detail IDs", async () => {
    const f = fixture();
    const groups = [{ group_name: "מקור", group_values: [{ test_id: "synthetic-test", message: "טקסט מקור", units: "mmol/L", result: 4.25 }] }, { group_name: "נוסף", group_values: [] }];
    const comparison = { current_result: groups[0]!.group_values[0], other_results: [] };
    f.deps.connect = async () => ({ readers: { listLatestLabResults: async () => ({ data: groups }), getLabComparison: async (...ids: unknown[]) => { expect(ids).toEqual([{ source: "result", requestId: "synthetic-request", docId: "synthetic-doc", testId: "synthetic-test" }]); return { data: comparison }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["latest-labs", "--limit", "1", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual([groups[0]]);
    const detail = fixture(); detail.deps.connect = f.deps.connect;
    expect(await runCli(["lab-comparison", "--source", "result", "--request", "synthetic-request", "--doc", "synthetic-doc", "--test", "synthetic-test", "--json"], detail.deps)).toBe(0);
    expect(JSON.parse(detail.output()).data).toEqual(comparison);
    for (const args of [["lab-comparison"], ["lab-comparison-pdf", "--out", "synthetic.pdf"], ["latest-labs-pdf"], ["latest-labs", "--owner", "forbidden"], ["lab-comparison", "--request", "r", "--doc", "d", "--test", "t", "--date", "2026-01-01"]]) {
      const invalid = fixture();
      expect(await runCli([...args, "--json"], invalid.deps)).toBe(2);
      expect(invalid.calls).toEqual([]);
    }
  });

  test("comparison latest/followed selections reject contradictory IDs before storage", async () => {
    for (const source of ["latest", "followed"]) {
      for (const [command, method] of [["lab-comparison", "getLabComparison"], ["lab-comparison-pdf", "getLabComparisonPdf"], ["lab-file-pdf", "getLabResultFilePdf"]]) {
        const f = fixture();
        const pdf = command!.endsWith("-pdf");
        f.deps.connect = async () => ({ readers: { [method!]: async (selection: unknown) => { expect(selection).toEqual({ source, testId: "synthetic-test" }); return { data: pdf ? new TextEncoder().encode("%PDF-synthetic") : { current_result: {}, other_results: [] } }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
        expect(await runCli([command!, "--source", source, "--test", "synthetic-test", ...(pdf ? ["--out", "synthetic.pdf"] : []), "--json"], f.deps)).toBe(0);
      }
      const invalid = fixture();
      expect(await runCli(["lab-comparison", "--source", source, "--test", "synthetic-test", "--request", "forbidden", "--doc", "forbidden", "--json"], invalid.deps)).toBe(2);
      expect(invalid.calls).toEqual([]);
    }
  });

  test("prescription filters preserve false and source subset provenance before local paging", async () => {
    const f = fixture();
    const rows = [{ doc_id: "synthetic", drug_name: "מקור" }, { doc_id: "second" }];
    f.deps.connect = async () => ({ readers: { listPrescriptions: async (options: unknown) => { expect(options).toEqual({ status: "history", permanent: false }); return { data: rows, source: { completeness: "local-filtered-subset" } }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["prescriptions", "--status", "history", "--permanent", "false", "--limit", "1", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual([rows[0]]);
    expect(JSON.parse(f.output()).source.completeness).toBe("local-filtered-subset");
    for (const flags of [["--status", "invented"], ["--permanent", "yes"], ["--permanent"]]) {
      const invalid = fixture();
      expect(await runCli(["prescriptions", ...flags, "--json"], invalid.deps)).toBe(2);
      expect(invalid.calls).toEqual([]);
    }
  });

  test("followed labs preserve the counter and selection options without changing follow state", async () => {
    const f = fixture();
    const original = { data: { followed_counter: 1, followed_tests: [{ test_id: "synthetic-test", is_follow: true }], options: [{ test_id: 1, test_desc: "מקור", is_follow: false }] }, source: { schemaEvidence: "frontend-field-projection" } };
    f.deps.connect = async () => ({ readers: { listFollowedLabResults: async () => original, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["followed-labs", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual(original);
    for (const args of [["followed-labs", "--follow", "true"], ["followed-labs-pdf"], ["followed-labs", "--limit", "1"]]) {
      const invalid = fixture();
      expect(await runCli([...args, "--json"], invalid.deps)).toBe(2);
      expect(invalid.calls).toEqual([]);
    }
  });

  test("future appointments retain frontend evidence and original populated display fields", async () => {
    const f = fixture();
    const rows = [{ date: "2026-10-01T10:00:00", provider_name: "שם סינתטי", provider_service_type: "מקור", description: "טקסט מקורי 123456789", waiting_list_status: null }, { date: "2026-10-02T10:00:00" }];
    const source = { operation: "future-appointments", schemaEvidence: "frontend-field-projection" };
    f.deps.connect = async () => ({ readers: { listFutureAppointments: async () => ({ data: rows, source }), currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["appointments", "--limit", "1", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual([rows[0]]);
    expect(JSON.parse(f.output()).source).toEqual(source);
    expect(JSON.parse(f.output()).page.upstreamTotalKnown).toBe(false);
  });

  test("future appointment detail uses only a returned reference and rejects list paging before storage", async () => {
    const reference = "a".repeat(64);
    const f = fixture();
    const original = { data: { appointment: { date: "2026-10-01T10:00:00" }, provider: { address: "כתובת סינתטית", phone: null }, instructions: [{ description: "הוראה מקורית", link: "https://example.invalid/instructions" }] }, source: { schemaEvidence: "frontend-field-projection" } };
    f.deps.connect = async () => ({ readers: { getFutureAppointment: async (value: string) => { expect(value).toBe(reference); return original; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["appointments", "--reference", reference, "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual(original);
    for (const flags of [["--reference", "malformed"], ["--reference", reference, "--limit", "1"], ["--reference", reference, "--owner", "forbidden"]]) {
      const invalid = fixture();
      expect(await runCli(["appointments", ...flags, "--json"], invalid.deps)).toBe(2);
      expect(invalid.calls).toEqual([]);
    }
  });

  test("vaccination dose selection preserves source evidence, nulls and clinical text", async () => {
    const f = fixture();
    const rows = [{ vaccination_date: "2026-01-02", vaccination_place: null, remark: "טקסט מקור 123456789" }, { vaccination_date: "2026-02-02" }];
    const source = { operation: "vaccination-doses", schemaEvidence: "frontend-field-projection" };
    f.deps.connect = async () => ({ readers: { getVaccinationDoses: async (code: number) => { expect(code).toBe(7); return { data: rows, source }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["vaccinations", "--group", "7", "--limit", "1", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual([rows[0]]);
    expect(JSON.parse(f.output()).source).toEqual(source);
    expect(JSON.parse(f.output()).page.upstreamTotalKnown).toBe(false);
  });

  test("settings reads preserve persisted state and intentional viewer identifiers without accepting mutations", async () => {
    const preferences = { data: { statusCode: 0, preferredLanguageCode: 1, contact: { cellPhone: "0000000000", email: "example@example.invalid" }, groups: [{ code: 1, name: "מקור", description: null, registered: false, canRegister: false, restrictionDescription: "הגבלה מקורית", restrictionCode: 2, order: 1, services: [] }] }, source: { operation: "notification-preferences", schemaEvidence: "frontend-field-projection" } };
    const access = { data: { state: "viewer-list", users: [{ first_name: "שם", last_name: "סינתטי", user_id: "000000000", authentication_end_date: "2026-12-31" }] }, source: { operation: "account-access", schemaEvidence: "frontend-field-projection" } };
    for (const [command, method, original] of [["notification-preferences", "getNotificationPreferences", preferences], ["account-access", "listAccountAccess", access]] as const) {
      const f = fixture();
      f.deps.connect = async () => ({ readers: { [method]: async (...args: unknown[]) => { expect(args).toEqual([]); return original; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
      expect(await runCli([command, "--json"], f.deps)).toBe(0);
      expect(JSON.parse(f.output())).toEqual(original);
      for (const flag of ["--owner", "--save", "--grant", "--limit"]) {
        const invalid = fixture();
        expect(await runCli([command, flag, "1", "--json"], invalid.deps)).toBe(2);
        expect(invalid.calls).toEqual([]);
      }
    }
  });

  test("contact profile preserves requested private contact fields and provenance", async () => {
    const f = fixture();
    const original = { data: { email: "example@example.invalid", phones_update_date: "2026-01-02", phones: [{ phone_type: "home", phone_prefix: "00", phone_no: 1234, fax_special_prefix: "" }], addresses: [{ city_name: "עיר סינתטית", street_name: "רחוב סינתטי", house_num: "1", apartment_num: "2" }] }, source: { service: "TokenServerAPI", operation: "contact-profile" } };
    f.deps.connect = async () => ({ readers: { getOwnerContactProfile: () => original, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["contact-profile", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual(original);
    expect(f.error()).toBe("");
  });

  test("notifications forward the explicit range and page original descriptions and dates", async () => {
    const f = fixture();
    const rows = ["א", "ב"].map(letter_desc => ({ letter_type: 1, letter_desc, item_date: "2026-01-02", original_item_date: "2026-01-01" }));
    const source = { service: "DirectorshipAPI", operation: "notifications" };
    f.deps.connect = async () => ({ readers: { listNotifications: async (selectedRange: unknown) => { expect(selectedRange).toEqual({ from: "2026-01-01", to: "2026-12-31" }); return { data: rows, source }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["notifications", "--from", "2026-01-01", "--to", "2026-12-31", "--limit", "1", "--offset", "1", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual([rows[1]]);
    expect(JSON.parse(f.output()).source).toEqual(source);
    expect(JSON.parse(f.output()).page.upstreamTotalKnown).toBe(false);
  });

  test("mailing statuses, tutorial PDF references and visible links survive CLI output", async () => {
    const f = fixture();
    const rows = [
      { letter_type: 2, status: 1, item_date: "2026-01-02", original_item_date: "2026-01-01", has_document: true, reference: "b".repeat(64) },
      { letter_type: 3, service_type_text: "מקור", practitioner_name: "שם סינתטי", item_date: "2026-01-02", original_item_date: "2026-01-01", tutorials: [{ tutorial_type: "pdf", display_text: "מסמך מקורי", pdf_reference: "a".repeat(64) }, { tutorial_type: "webpage", display_text: "הוראה", link: "https://example.invalid/instructions" }] },
    ];
    const original = { data: rows, source: { operation: "notifications", schemaEvidence: "frontend-field-projection" } };
    f.deps.connect = async () => ({ readers: { listNotifications: async () => original, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["notifications", "--from", "2026-01-01", "--to", "2026-12-31", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual(original);
    expect(JSON.parse(f.output()).data[0].reference).toBe("b".repeat(64));
  });

  test("legacy summaries preserve clinical text, complete tables and provenance", async () => {
    const table = { columns: ["כותרת סינתטית", "ערך"], rows: [["טקסט 123456789", "4.25 mmol/L"]] };
    const cases = [
      ["recommendations", "getMedicalRecommendations", { introduction: "פתיחה", sections: [{ title: "מקור", table }], closingNote: "הערה" }],
      ["medical-summary", "getSelectedMedicalSummary", { description: "תיאור", medications: { title: "תרופות", context: "מקור", table }, laboratory: { title: "מעבדה", context: "מקור", table } }],
    ] as const;
    for (const [command, method, data] of cases) {
      const f = fixture();
      const original = { data, source: { service: "LegacyMedicalFile", operation: command, completeness: "upstream-response" } };
      f.deps.connect = async () => ({ readers: { [method]: async () => original, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
      expect(await runCli([command, "--json", "--no-input"], f.deps)).toBe(0);
      expect(JSON.parse(f.output())).toEqual(original);
      expect(f.prompts).toEqual([]);
    }
  });

  test("hospital optional range is forwarded unchanged for list and PDF, invalid pairs fail before storage", async () => {
    const selected = { from: "2026-01-01", to: "2026-09-01" };
    for (const pdf of [false, true]) {
      const f = fixture();
      const method = pdf ? "getHospitalReportPdf" : "listHospitalHistory";
      f.deps.connect = async () => ({ readers: { [method]: async (...args: unknown[]) => { expect(args).toEqual(pdf ? ["a".repeat(64), "2026-09-20", selected] : ["2026-09-20", selected]); return { data: pdf ? new TextEncoder().encode("%PDF-synthetic") : [] }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
      expect(await runCli([pdf ? "hospital-pdf" : "hospital-history", "--as-of", "2026-09-20", "--from", selected.from, "--to", selected.to, ...(pdf ? ["--reference", "a".repeat(64), "--out", "synthetic.pdf"] : []), "--json"], f.deps)).toBe(0);
    }
    for (const flags of [["--from", selected.from], ["--from", selected.to, "--to", selected.from], ["--from", selected.from, "--to", "2026-10-01"]]) {
      const f = fixture(); expect(await runCli(["hospital-history", "--as-of", "2026-09-20", ...flags, "--json"], f.deps)).toBe(2); expect(f.calls).toEqual([]);
    }
  });

  test("hospital history forwards the explicit calendar date and pages complete source rows", async () => {
    const f = fixture();
    const rows = ["א", "ב"].map(NameHospital => ({ NameHospital, DateHospitalization: "2026-01-02", Date: "מקור", DurationHospitalization: "1", QuantityTreatments: "1", TypeCommitment: "מקור", Department: "דוגמה", HasLink: false, DescriptionTreatment: [{ Description: "טקסט קליני" }], DescriptionDistinction: [] }));
    const source = { service: "LegacyHospitalMailings", operation: "hospital-history" };
    f.deps.connect = async () => ({ readers: { listHospitalHistory: async (asOf: string) => { expect(asOf).toBe("2026-09-20"); return { data: rows, source }; }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["hospital-history", "--as-of", "2026-09-20", "--limit", "1", "--offset", "1", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual([rows[1]]);
    expect(JSON.parse(f.output()).source).toEqual(source);
    expect(JSON.parse(f.output()).page.upstreamTotalKnown).toBe(false);
  });

  test("additional-information list preserves frontend evidence, display fields and explicit range", async () => {
    const f = fixture();
    const rows = [{ session_datetime: "2026-01-02", type_id: 1, display_text: "מידע סינתטי", practitioner_name: "דוגמה", specialization: "מקור" }];
    const source = { operation: "additional-information", schemaEvidence: "frontend-field-projection" };
    f.deps.connect = async () => ({ readers: { listAdditionalInformation: async (selectedRange: unknown) => {
      expect(selectedRange).toEqual({ from: "2026-01-01", to: "2026-12-31" }); return { data: rows, source };
    }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["additional-information", "--from", "2026-01-01", "--to", "2026-12-31", "--limit", "1", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual(rows);
    expect(JSON.parse(f.output()).source).toEqual(source);
    expect(JSON.parse(f.output()).page.upstreamTotalKnown).toBe(false);
  });

  test("certificate PDF forwards the returned reference and identical explicit range", async () => {
    const f = fixture();
    f.deps.connect = async () => ({ readers: { getCertificatePdf: async (reference: string, range: unknown) => {
      expect(reference).toBe("a".repeat(64));
      expect(range).toEqual({ from: "2026-01-01", to: "2026-12-31" });
      return { data: new TextEncoder().encode("%PDF-synthetic") };
    }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["certificate-pdf", "--reference", "a".repeat(64), "--from", "2026-01-01", "--to", "2026-12-31", "--out", "synthetic-certificate.pdf", "--json"], f.deps)).toBe(0);
    expect(f.calls).toContain("save-pdf");
    expect(JSON.parse(f.output())).toEqual({ status: "saved", bytes: 14 });
  });

  test("imaging PDF forwards the owner-list reference pair and preserves original bytes", async () => {
    const f = fixture();
    f.deps.connect = async () => ({ readers: { getImagingResultPdf: async (request: string, doc: string) => {
      expect([request, doc]).toEqual(["synthetic-request", "synthetic-doc"]);
      return { data: new TextEncoder().encode("%PDF-synthetic") };
    }, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["imaging-pdf", "--request", "synthetic-request", "--doc", "synthetic-doc", "--out", "synthetic-imaging.pdf", "--json"], f.deps)).toBe(0);
    expect(f.calls).toContain("save-pdf");
    expect(JSON.parse(f.output())).toEqual({ status: "saved", bytes: 14 });
  });

  test("administrative request list retains source evidence and reports honest empty local selection", async () => {
    const f = fixture();
    const result = { data: [], source: { operation: "administrative-requests", completeness: "upstream-response", schemaEvidence: "frontend-field-projection" } };
    f.deps.connect = async () => ({ readers: { listAdministrativeRequests: async () => result, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["administrative-requests", "--limit", "20", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data).toEqual([]);
    expect(JSON.parse(f.output()).source).toEqual(result.source);
    expect(JSON.parse(f.output()).page.availableInResponse).toBe(0);
    expect(JSON.parse(f.output()).page.upstreamTotalKnown).toBe(false);
  });

  test("payer billing output preserves aggregate scope and original amounts without debtor or currency inference", async () => {
    const f = fixture();
    const result = { data: { kupa_debt: 12, shaban_debt: 3, additional_charges_debt: 0 }, source: { operation: "outstanding-debt", scope: "payer-account-aggregate" } };
    f.deps.connect = async () => ({ readers: { getOutstandingDebt: async () => result, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["billing-totals", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual(result);
    expect(f.error()).toBe("");
  });

  test("payment-authorization summary passes through without introducing full account data", async () => {
    const f = fixture();
    const result = { data: { payment_method: 1, is_active_auth_exists: true, bank_name: "בנק סינתטי", last_four_digits_credit_card: "1234" }, source: { operation: "payment-methods" } };
    f.deps.connect = async () => ({ readers: { getPaymentMethods: async () => result, currentOwner: owner } as unknown as Connected["readers"], exportSession: async () => session });
    expect(await runCli(["payment-methods", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual(result);
    expect(f.error()).toBe("");
  });

  test("existing inquiry list and detail use returned references and preserve original response text", async () => {
    for (const detail of [false, true]) {
      const f = fixture();
      const listResult = { data: [{ request_id: "synthetic-request", type: "medical_form_request" }], source: { operation: "inquiries" } };
      const detailResult = { data: { response: "תשובה סינתטית מלאה" }, source: { operation: "inquiry" } };
      f.deps.connect = async () => ({ readers: {
        listInquiries: async () => { f.calls.push("inquiry-list"); return listResult; },
        getInquiry: async (id: string) => { expect(id).toBe("synthetic-request"); f.calls.push("inquiry-detail"); return detailResult; },
        currentOwner: owner,
      } as unknown as Connected["readers"], exportSession: async () => session });
      expect(await runCli(detail ? ["inquiries", "--id", "synthetic-request", "--json"] : ["inquiries", "--limit", "1", "--json"], f.deps)).toBe(0);
      expect(JSON.parse(f.output()).data).toEqual((detail ? detailResult : listResult).data);
      expect(f.calls).toContain(detail ? "inquiry-detail" : "inquiry-list");
      expect(f.calls).not.toContain(detail ? "inquiry-list" : "inquiry-detail");
    }
  });

  test("login uses hidden credential prompts, sends one requested SMS and persists owner binding", async () => {
    const f = fixture(null);
    expect(await runCli(["login"], f.deps)).toBe(0);
    expect(f.prompts.every(prompt => prompt.hidden)).toBe(true);
    expect(f.prompts).toHaveLength(2); // One distinct SMS choice needs only ID and OTP prompts.
    expect(f.calls).toEqual(["load", "begin", "send-sms", "verify-otp", "connect", "save"]);
    expect(f.stored()?.owner).toEqual(owner);
    expect(f.output()).not.toContain("123456");
    expect(f.output()).not.toContain("synthetic.session.token");
    expect(f.error()).not.toContain("012345678");
  });

  test("the SMS-sent sentence uses the bare display value, never the menu's \"Phone \" prefix, for every label shape", async () => {
    for (const phone of [
      { index: 0, label: "Phone 052-*****63", display: "052-*****63", smsAvailable: true }, // supplied mask
      { index: 0, label: "Phone ending 0012", display: "ending 0012", smsAvailable: true }, // ending NNNN
      { index: 0, label: "Phone 1", display: "1", smsAvailable: true }, // ordinal
    ]) {
      const f = fixture(null);
      f.phones.length = 0;
      f.phones.push(phone);
      expect(await runCli(["login"], f.deps)).toBe(0);
      expect(f.error()).toContain(`Code sent by SMS to ${phone.display}\n`);
      expect(f.error()).not.toContain("Phone ");
    }
  });

  test("--id sends one SMS to the only usable number and persists the challenge, never echoing the ID", async () => {
    const f = fixture(null);
    expect(await runCli(["login", "--id", "012345678", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual(["load", "begin", "send-sms", "export-pending", "save-pending"]);
    expect(f.smsPhones).toEqual([0]);
    expect(JSON.parse(f.output())).toEqual({ status: "sms-sent", phone: "ending 12", expiresInSeconds: expect.any(Number) });
    expect(JSON.parse(f.output()).expiresInSeconds).toBeGreaterThan(590);
    expect(f.pending()?.id).toBe("synthetic-challenge");
    expect(f.output()).not.toContain("012345678");
    expect(f.prompts).toEqual([]);
  });

  test("several SMS numbers are listed for an explicit choice and nothing is sent", async () => {
    const f = fixture(null);
    f.phones.push({ index: 2, label: "Phone ending 34", display: "ending 34", smsAvailable: true }, { index: 3, label: "Landline", display: "Landline", smsAvailable: false });
    expect(await runCli(["login", "--id", "012345678", "--json"], f.deps)).toBe(3);
    expect(f.calls).toEqual(["load", "begin", "export-pending", "save-pending"]);
    expect(JSON.parse(f.output())).toEqual({ status: "phone-required", phones: [{ option: 1, label: "Phone ending 12" }, { option: 3, label: "Phone ending 34" }], expiresInSeconds: expect.any(Number) });
    expect(f.pending()).not.toBeNull();
  });

  test("--phone selects the listed option and the upstream index it came from", async () => {
    const f = fixture(null);
    f.phones.push({ index: 2, label: "Phone ending 34", display: "ending 34", smsAvailable: true });
    expect(await runCli(["login", "--id", "012345678", "--phone", "3", "--json"], f.deps)).toBe(0);
    expect(f.smsPhones).toEqual([2]);
    expect(JSON.parse(f.output())).toMatchObject({ status: "sms-sent", phone: "ending 34" });
  });

  test("--code finishes the persisted challenge, binds its owner and clears the pending file", async () => {
    const f = fixture(null, challenge());
    expect(await runCli(["login", "--code", "123456", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual(["load-pending", "restore-pending", "verify-otp", "connect", "save", "delete-pending"]);
    expect(JSON.parse(f.output())).toEqual({ status: "signed-in", persistence: "session-file" });
    expect(f.stored()?.owner).toEqual(owner);
    expect(f.pending()).toBeNull();
    expect(f.output()).not.toContain("123456");
  });

  test("a wrong code ends the challenge instead of allowing another attempt", async () => {
    const f = fixture(null, challenge());
    f.deps.createAuth = (create => () => ({ ...create(), completeLogin: async () => { throw new UpstreamError("OTP_REJECTED"); } }))(f.deps.createAuth);
    expect(await runCli(["login", "--code", "123456"], f.deps)).toBe(1);
    expect(f.pending()).toBeNull();
    expect(f.error()).toContain("OTP_REJECTED");
    expect(f.error()).not.toContain("123456");
    expect(await runCli(["login", "--code", "123456"], f.deps)).toBe(3);
    expect(f.error()).toContain("NO_PENDING_LOGIN");
  });

  test("a code with no started login is refused before any upstream call", async () => {
    const f = fixture(null);
    expect(await runCli(["login", "--code", "123456", "--json"], f.deps)).toBe(3);
    expect(f.calls).toEqual(["load-pending"]);
    expect(JSON.parse(f.error()).error.code).toBe("NO_PENDING_LOGIN");
    expect(f.output()).toBe("");
  });

  test("MACCABI_ID and MACCABI_OTP stand in for the flags, which win when both are present", async () => {
    const f = fixture(null);
    f.deps.env = { MACCABI_ID: "012345678" };
    expect(await runCli(["login", "--json"], f.deps)).toBe(0);
    expect(f.calls).toContain("send-sms");

    const g = fixture(null, challenge());
    g.deps.env = { MACCABI_OTP: "999999" };
    expect(await runCli(["login", "--code", "123456", "--json"], g.deps)).toBe(0);
    expect(g.calls).toContain("verify-otp");

    const h = fixture(null);
    h.deps.env = { MACCABI_ID: "012345678", MACCABI_OTP: "123456" };
    expect(await runCli(["login", "--json"], h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  test("login --status reports signed-out, a waiting challenge and a saved session without upstream calls", async () => {
    const out = fixture(null);
    expect(await runCli(["login", "--status", "--json"], out.deps)).toBe(0);
    expect(JSON.parse(out.output())).toEqual({ status: "signed-out" });
    expect(out.calls).toEqual(["load", "load-pending"]);

    const waiting = fixture(null, challenge());
    expect(await runCli(["login", "--status", "--json"], waiting.deps)).toBe(0);
    expect(JSON.parse(waiting.output())).toEqual({ status: "pending-login", smsSent: true, expiresInSeconds: expect.any(Number) });

    const unsent = fixture(null, { ...challenge(), validatorJwt: undefined });
    expect(await runCli(["login", "--status", "--json"], unsent.deps)).toBe(0);
    expect(JSON.parse(unsent.output())).toMatchObject({ status: "pending-login", smsSent: false });

    const signedIn = fixture();
    expect(await runCli(["login", "--status", "--json"], signedIn.deps)).toBe(0);
    expect(JSON.parse(signedIn.output())).toEqual({ status: "signed-in" });
    expect(signedIn.calls).toEqual(["load"]);
  });

  test("malformed login flags are rejected before storage or upstream and never echoed", async () => {
    for (const argv of [["login", "--id", "0123456789"], ["login", "--id", "12a"], ["login", "--code", "12345"], ["login", "--code", "1234567"], ["login", "--id", "012345678", "--phone", "0"], ["login", "--id", "012345678", "--phone", "9z9"], ["login", "--status", "extra"]]) {
      const f = fixture(null);
      expect(await runCli([...argv, "--json"], f.deps)).toBe(2);
      expect(f.calls).toEqual([]);
      expect(JSON.parse(f.error()).error.code).toBe("INVALID_USAGE");
      for (const value of argv.slice(1).filter(arg => !arg.startsWith("--"))) expect(f.error()).not.toContain(value);
      expect(f.output()).toBe("");
    }
  });

  test("flag login works without a terminal, and only a bare login still demands one", async () => {
    const f = fixture(null);
    f.deps.isInteractive = () => false;
    expect(await runCli(["login", "--id", "012345678"], f.deps)).toBe(0);
    expect(f.calls).toContain("send-sms");

    const bare = fixture(null);
    bare.deps.isInteractive = () => false;
    expect(await runCli(["login"], bare.deps)).toBe(3);
    expect(bare.error()).toContain("--id");
    expect(bare.calls).toEqual([]);
  });

  test("a failed start cancels the challenge and leaves nothing pending", async () => {
    const f = fixture(null, challenge());
    f.deps.createAuth = (create => () => ({ ...create(), requestOtp: async () => { throw new UpstreamError("SMS_SEND_FAILED"); } }))(f.deps.createAuth);
    expect(await runCli(["login", "--id", "012345678"], f.deps)).toBe(1);
    expect(f.calls).toEqual(["load", "begin", "cancel", "delete-pending"]);
    expect(f.pending()).toBeNull();
  });

  test("saved status is explicitly unverified and makes no connection", async () => {
    const f = fixture();
    expect(await runCli(["status", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual({ status: "saved", verified: false });
    expect(f.calls).toEqual(["load"]);
  });

  test("login failure after sending SMS does not claim no SMS was sent", async () => {
    const f = fixture(null);
    f.deps.connect = async () => { throw new ReauthenticationRequired(401); };
    expect(await runCli(["login"], f.deps)).toBe(3);
    expect(f.calls.filter(call => call === "send-sms")).toHaveLength(1);
    expect(f.error()).not.toContain("no SMS was sent");
    expect(f.error()).toContain("No automatic SMS retry was made");
    expect(f.output()).toBe("");
  });

  test("verified status refreshes persistence without exposing the profile", async () => {
    const f = fixture();
    expect(await runCli(["status", "--verify", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual({ status: "signed-in", verified: true });
    expect(f.calls).toEqual(["load", "connect", "save"]);
    expect(f.output()).not.toContain("דוגמה");
  });

  test("status estimates the absolute cap from F5_ST locally, and stays quiet when it cannot", async () => {
    // 1767225600 is 2026-01-01T00:00:00Z; the fifth field is the timeout F5 enforces from that start.
    const withCookie = (value: unknown): SavedLogin => ({
      owner,
      // `value` is typed string | undefined but arrives from the wire, so non-string junk is covered too.
      session: { ...session, cookies: { ...session.cookies, cookies: [{ key: "SOMETHING_ELSE", value: "ignored" }, ...(value === undefined ? [] : [{ key: "F5_ST", value } as { key: string; value: string }])] } },
    });
    const good = fixture(withCookie("1z1z1z1767225600z3600"));
    expect(await runCli(["status", "--json"], good.deps)).toBe(0);
    const reported = JSON.parse(good.output());
    expect(reported.expiresAt).toBe("2026-01-01T01:00:00.000Z");
    expect(reported.expiryNote).toContain("keep-alive");
    expect(good.output()).not.toContain("1767225600");
    expect(good.calls).toEqual(["load"]);

    const verified = fixture(withCookie("1z1z1z1767225600z3600"));
    expect(await runCli(["status", "--verify", "--json"], verified.deps)).toBe(0);
    expect(JSON.parse(verified.output()).expiresAt).toBe("2026-01-01T01:00:00.000Z");

    // Absent, wrong field count, non-numeric fields and digits too large for a date all report nothing rather than guessing.
    for (const value of [undefined, 12345, "", "1z1z1z1767225600", "1z1z1z1767225600z3600z9", "1z1z1zabcz3600", "1z1z1z1767225600z", "1z1z1z1767225600z99999999999999999999"]) {
      const f = fixture(withCookie(value));
      expect(await runCli(["status", "--json"], f.deps)).toBe(0);
      expect(JSON.parse(f.output())).toEqual({ status: "saved", verified: false });
    }
  });

  test("forced reauthentication names both literal login invocations and still promises no SMS retry", async () => {
    const f = fixture();
    f.deps.connect = async () => { throw new ReauthenticationRequired(401); };
    expect(await runCli(["prescriptions", "--json", "--no-input"], f.deps)).toBe(3);
    const message = JSON.parse(f.error()).error.message;
    expect(message).toContain("`maccabi login`");
    expect(message).toContain("`maccabi login --id <id>`");
    expect(message).toContain("`maccabi login --code <code>`");
    expect(message).toContain("`--phone <n>`");
    expect(message).toContain("No automatic SMS retry was made.");
  });

  test("keep-alive help names the idle timeout it defeats and the cap it cannot", async () => {
    const f = fixture();
    expect(await runCli(["help", "keep-alive", "--json"], f.deps)).toBe(0);
    const entry = JSON.parse(f.output()).commands.find((command: { name: string }) => command.name === "keep-alive");
    expect(entry.notes).toContain("idle");
    expect(entry.notes).toContain("absolute cap");
    expect(entry.notes).toContain("--interval 240 --duration 3600");
    expect(f.calls).toEqual([]);
  });

  test("expired session is deleted and never triggers login or SMS", async () => {
    const f = fixture();
    f.deps.connect = async () => { throw new ReauthenticationRequired(401); };
    expect(await runCli(["prescriptions"], f.deps)).toBe(3);
    expect(f.stored()).toBeNull();
    expect(f.calls).toEqual(["load", "delete"]);
    expect(f.output()).toBe("");
  });

  test("unknown detail references fail without deleting a valid login", async () => {
    const f = fixture();
    f.deps.connect = async () => ({
      readers: {
        currentOwner: owner,
        getLabResult: async () => { throw new ReadOperationError("OWNER_MISMATCH", "lab-result"); },
      } as unknown as Connected["readers"],
      exportSession: async () => session,
    });
    expect(await runCli(["labs", "--request", "unknown", "--doc", "unknown"], f.deps)).toBe(1);
    expect(f.stored()).toEqual(saved);
    expect(f.calls).not.toContain("delete");
    expect(f.error()).not.toContain("new login");
  });

  test("a dependent selected in the portal keeps the saved login and does not ask for one", async () => {
    for (const code of ["DEPENDENT_SELECTED", "OWNER_MISMATCH"] as const) {
      const f = fixture();
      f.deps.connect = async () => { throw new ReadOperationError(code, "account"); };
      expect(await runCli(["status", "--verify", "--json"], f.deps)).toBe(1);
      expect(f.stored()).toEqual(saved);
      expect(f.calls).not.toContain("delete");
      expect(JSON.parse(f.error()).error.code).toBe(code);
    }
    const dependent = fixture();
    dependent.deps.connect = async () => { throw new ReadOperationError("DEPENDENT_SELECTED", "account"); };
    await runCli(["status", "--verify", "--json"], dependent.deps);
    expect(JSON.parse(dependent.error()).error.message).toContain("no new login is needed");
  });

  test("failed expired-credential removal is reported explicitly", async () => {
    const f = fixture();
    f.deps.connect = async () => { throw new ReauthenticationRequired(401); };
    f.deps.store.delete = async () => { throw new Error("sensitive storage provider error"); };
    expect(await runCli(["status", "--verify"], f.deps)).toBe(1);
    expect(f.stored()).toEqual(saved);
    expect(f.error()).toContain("could not be removed");
    expect(f.error()).not.toContain("sensitive storage provider error");
  });

  test("intended clinical JSON is preserved and tokens stay out", async () => {
    const f = fixture();
    expect(await runCli(["prescriptions", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.output()).data[0].drug_name).toBe("תרופה סינתטית");
    expect(f.output()).not.toContain("Bearer");
    expect(f.error()).toBe("");
  });

  test("PDF output uses the file adapter and no binary enters stdout", async () => {
    const f = fixture();
    expect(await runCli(["referral-pdf", "--id", "synthetic-referral", "--out", "synthetic.pdf"], f.deps)).toBe(0);
    expect(f.calls).toContain("save-pdf");
    expect(f.output()).not.toContain("%PDF");
  });

  test("lab year selection goes through the shared local-filter option", async () => {
    const f = fixture();
    expect(await runCli(["labs", "--year", "2025", "--json"], f.deps)).toBe(0);
    expect(f.calls).toContain("labs-year");
    expect(JSON.parse(f.output()).source.completeness).toBe("local-filtered-subset");
  });

  test("malformed command/paired options are rejected before reading storage or contacting upstream", async () => {
    for (const argv of [["login", "--id", "secret"], ["labs", "--request", "only-one"], ["labs", "--year", "2025", "--request", "r", "--doc", "d"], ["labs", "--year", "not-year"], ["referrals", "--from", "2026-01-01"], ["referral-pdf", "--id", "ref"]]) {
      const f = fixture();
      expect(await runCli(argv, f.deps)).toBe(2);
      expect(f.calls).toEqual([]);
      expect(f.error()).not.toContain("secret");
    }
  });

  test("local logout clears the session and any waiting challenge without an upstream request", async () => {
    const f = fixture(saved, challenge());
    expect(await runCli(["logout"], f.deps)).toBe(0);
    expect(f.calls).toEqual(["delete", "delete-pending"]);
    expect(f.stored()).toBeNull();
    expect(f.pending()).toBeNull();
    expect(JSON.parse(f.output())).toEqual({ status: "local-session-removed" });
  });

  test("logout --all also clears what the browser sign-in wrote outside session.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maccabi-logout-"));
    const f = fixture(saved, challenge());
    f.deps.env = { MACCABI_CONFIG_DIR: directory };
    await mkdir(join(directory, "sessions"), { recursive: true });
    await writeFile(join(directory, "sessions", "0123456789abcdef0123456789abcdef.json"), "{}", { mode: 0o600 });
    await writeFile(join(directory, "oauth.json"), "{}", { mode: 0o600 });
    expect(await runCli(["logout", "--all"], f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual({ status: "local-session-removed", browserSessions: "removed" });
    expect(f.stored()).toBeNull();
    expect(await readdir(directory)).toEqual([]);
    // Nothing to delete is still a success: the flag is how a member makes sure, not a report of what existed.
    const second = fixture(null);
    second.deps.env = { MACCABI_CONFIG_DIR: directory };
    expect(await runCli(["logout", "--all"], second.deps)).toBe(0);
    await rm(directory, { recursive: true, force: true });
  });

  test("--all belongs to logout alone", async () => {
    const f = fixture();
    expect(await runCli(["login", "--all"], f.deps)).toBe(2);
    expect(await runCli(["status", "--all"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
  });

  test("unexpected exceptions are safe even if their message contains credentials", async () => {
    const f = fixture();
    f.deps.connect = async () => { throw new Error("Bearer synthetic.secret.token otp=654321"); };
    expect(await runCli(["profile"], f.deps)).toBe(1);
    expect(f.error()).not.toContain("synthetic.secret.token");
    expect(f.error()).not.toContain("654321");
  });

  test("JSON failures keep authentication, read, storage and unexpected errors machine-readable", async () => {
    for (const [error, code, exitCode] of [
      [new ReauthenticationRequired(401), "AUTH_REQUIRED", 3],
      [new ReadOperationError("OWNER_MISMATCH", "lab-result"), "OWNER_MISMATCH", 1],
      [new UpstreamError("HTTP_ERROR", 403), "HTTP_ERROR", 1],
      [new SessionStoreError(), "SESSION_STORE_UNAVAILABLE", 1],
      [new Error("Bearer synthetic.secret.token otp=654321"), "COMMAND_FAILED", 1],
    ] as const) {
      const f = fixture();
      f.deps.connect = async () => { throw error; };
      expect(await runCli(["profile", "--json"], f.deps)).toBe(exitCode);
      expect(JSON.parse(f.error()).error.code).toBe(code);
      expect(JSON.parse(f.error()).error.exitCode).toBe(exitCode);
      if (error instanceof SessionStoreError) expect(JSON.parse(f.error()).error.message).toContain("maccabi config directory");
      // Only a reauthentication may remove the saved login; a 403 from the edge must not cost one.
      if (code !== "AUTH_REQUIRED") { expect(f.stored()).toEqual(saved); expect(f.calls).not.toContain("delete"); }
      // And when it is a real expiry the file really does go, so the message has to say so. The MCP
      // server deletes on the same one condition and repeats this sentence; the two must not drift.
      else {
        expect(f.stored()).toBe(null);
        expect(f.calls).toContain("delete");
        expect(JSON.parse(f.error()).error.message).toContain("removed from local storage");
      }
      expect(f.output()).toBe("");
      expect(f.error()).not.toContain("synthetic.secret.token");
      expect(f.error()).not.toContain("654321");
    }
  });

  test("help and unanticipated failures point at the issue tracker; a typo and a missing login do not", async () => {
  const text = fixture();
  expect(await runCli(["help"], text.deps)).toBe(0);
  expect(text.output()).toContain(ISSUES_URL);
  const json = fixture();
  expect(await runCli(["help", "--json"], json.deps)).toBe(0);
  expect(JSON.parse(json.output()).issues).toBe(ISSUES_URL);

  // COMMAND_FAILED is the branch nothing else matched, which is the definition of a failure we did not foresee.
  const unexpected = fixture();
  unexpected.deps.connect = async () => { throw new Error("synthetic unexpected failure"); };
  expect(await runCli(["profile", "--json"], unexpected.deps)).toBe(1);
  expect(JSON.parse(unexpected.error()).error.code).toBe("COMMAND_FAILED");
  expect(JSON.parse(unexpected.error()).error.message).toContain(ISSUES_URL);

  // A mistyped command and an expired session are the member's business; a bug report would be noise.
  const usage = fixture();
  expect(await runCli(["not-a-real-command", "--json"], usage.deps)).toBe(2);
  expect(JSON.parse(usage.error()).error.code).toBe("INVALID_USAGE");
  expect(usage.error()).not.toContain(ISSUES_URL);
  const auth = fixture();
  auth.deps.connect = async () => { throw new ReauthenticationRequired(401); };
  expect(await runCli(["profile", "--json"], auth.deps)).toBe(3);
  expect(JSON.parse(auth.error()).error.code).toBe("AUTH_REQUIRED");
  expect(auth.error()).not.toContain(ISSUES_URL);
});
test("network timeouts have actionable JSON errors and keep the session without retries", async () => {
    const f = fixture();
    f.deps.connect = async () => { f.calls.push("connect"); throw new UpstreamError("REQUEST_TIMEOUT"); };
    expect(await runCli(["profile", "--json"], f.deps)).toBe(1);
    expect(JSON.parse(f.error()).error.code).toBe("REQUEST_TIMEOUT");
    expect(JSON.parse(f.error()).error.message).toContain("Check connectivity");
    expect(f.output()).toBe("");
    expect(f.calls).toEqual(["load", "connect"]);
    expect(f.stored()).toEqual(saved);
    expect(f.prompts).toEqual([]);
  });
});

describe("saved session file", () => {
  const temporary = () => mkdtemp(join(tmpdir(), "maccabi-store-test-"));

  test("round trips one owner-only file, creates its directory closed, and forgets it on delete", async () => {
    const path = join(await temporary(), "config", "session.json");
    const store = new FileSessionStore(path);
    expect(await store.load()).toBeNull();
    await store.save(saved);
    expect(await store.load()).toEqual(saved);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    await store.delete();
    await store.delete();
    expect(await store.load()).toBeNull();
  });

  test("replacing a session leaves no temporary file and never a truncated one", async () => {
    const directory = await temporary();
    const path = join(directory, "session.json");
    const store = new FileSessionStore(path);
    await store.save(saved);
    await store.save({ ...saved, owner: { memberId: 87654321, memberIdCode: "0" } });
    expect((await store.load())?.owner.memberId).toBe(87654321);
    expect(JSON.parse(await readFile(path, "utf8")).owner.memberId).toBe(87654321);
    expect(await readdir(directory)).toEqual(["session.json"]);
  });

  test("concurrent saves all succeed and leave exactly one intact session file", async () => {
    // A shared temporary path made writers collide: the loser's cleanup removed the winner's file
    // before it could be renamed, so every writer failed and the session could vanish entirely.
    for (const writers of [2, 3]) {
      const directory = await temporary();
      const path = join(directory, "session.json");
      const store = new FileSessionStore(path);
      const owners = Array.from({ length: writers }, (_, index) => ({ memberId: 20_000_000 + index, memberIdCode: "0" }));
      await Promise.all(owners.map(next => store.save({ ...saved, owner: next })));
      expect(await readdir(directory)).toEqual(["session.json"]);
      const loaded = await store.load();
      expect(loaded).not.toBeNull();
      expect(owners.map(next => next.memberId)).toContain(loaded!.owner.memberId);
      expect(loaded!.session).toEqual(session);
      expect(JSON.parse(await readFile(path, "utf8")).owner.memberId).toBe(loaded!.owner.memberId);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("concurrent pending-login saves keep one usable challenge", async () => {
    const directory = await temporary();
    const path = join(directory, "pending-login.json");
    const store = new FilePendingLoginStore(path);
    const ids = ["first-challenge", "second-challenge", "third-challenge"];
    await Promise.all(ids.map(id => store.save({ ...challenge(), id })));
    expect(await readdir(directory)).toEqual(["pending-login.json"]);
    expect(ids).toContain((await store.load())?.id);
  });

  test("a failed save leaves the previously stored session untouched", async () => {
    const directory = await temporary();
    const path = join(directory, "session.json");
    const store = new FileSessionStore(path);
    await store.save(saved);
    const unwritable = { get owner() { throw new Error("synthetic serialization failure"); } } as unknown as SavedLogin;
    await expect(store.save(unwritable)).rejects.toBeInstanceOf(SessionStoreError);
    expect(await store.load()).toEqual(saved);
    expect(await readdir(directory)).toEqual(["session.json"]);
  });

  test("a damaged session file asks for a fresh login instead of returning junk", async () => {
    const path = join(await temporary(), "session.json");
    const store = new FileSessionStore(path);
    for (const content of ["not json", '{"session":{"version":2},"owner":{"memberId":1,"memberIdCode":"0"}}', JSON.stringify({ session, owner: { memberId: "12345678" } })]) {
      await writeFile(path, content, { mode: 0o600 });
      await expect(store.load()).rejects.toBeInstanceOf(SessionStoreError);
      await expect(store.load()).rejects.toThrow("maccabi logout");
    }
  });

  test("a group- or world-readable session file still loads, with one warning", async () => {
    const path = join(await temporary(), "session.json");
    const store = new FileSessionStore(path);
    await store.save(saved);
    await chmod(path, 0o644);
    const warnings = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await store.load()).toEqual(saved);
      expect(warnings.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining("readable by other users")]);
    } finally { warnings.mockRestore(); }
  });

  test("a pending login round trips in its own protected file and is forgotten on delete", async () => {
    const directory = await temporary();
    const path = join(directory, "config", "pending-login.json");
    const store = new FilePendingLoginStore(path);
    const waiting = challenge();
    expect(await store.load()).toBeNull();
    await store.save(waiting);
    expect(await store.load()).toEqual(waiting);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    await store.save({ ...waiting, id: "second-challenge" });
    expect((await store.load())?.id).toBe("second-challenge");
    expect(await readdir(join(directory, "config"))).toEqual(["pending-login.json"]);
    await store.delete();
    await store.delete();
    expect(await store.load()).toBeNull();
  });

  test("an expired challenge reads as absent and its file is removed", async () => {
    const path = join(await temporary(), "pending-login.json");
    const expiresAt = Date.now() + 600_000;
    let clock = expiresAt - 1;
    const store = new FilePendingLoginStore(path, () => clock);
    await store.save({ ...challenge(), expiresAt });
    expect((await store.load())?.id).toBe("synthetic-challenge");
    clock = expiresAt;
    expect(await store.load()).toBeNull();
    await expect(stat(path)).rejects.toThrow();
  });

  test("a damaged pending file asks for a fresh login instead of resuming junk", async () => {
    const path = join(await temporary(), "pending-login.json");
    const store = new FilePendingLoginStore(path);
    for (const content of ["not json", JSON.stringify({ ...challenge(), version: 2 }), JSON.stringify({ ...challenge(), senderJwt: undefined }), JSON.stringify({ ...challenge(), memberId: "12345678" }), JSON.stringify({ ...challenge(), cookies: {} })]) {
      await writeFile(path, content, { mode: 0o600 });
      await expect(store.load()).rejects.toBeInstanceOf(SessionStoreError);
      await expect(store.load()).rejects.toThrow("maccabi logout");
    }
  });

  test("a group- or world-readable pending file still loads, with one warning", async () => {
    const path = join(await temporary(), "pending-login.json");
    const store = new FilePendingLoginStore(path);
    await store.save(challenge());
    await chmod(path, 0o644);
    const warnings = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect((await store.load())?.id).toBe("synthetic-challenge");
      expect(warnings.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining("readable by other users")]);
    } finally { warnings.mockRestore(); }
  });

  test("the config directory follows the documented environment precedence", () => {
    const windows = process.platform === "win32";
    expect(configDirectory({ MACCABI_CONFIG_DIR: "/explicit", XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\AppData" })).toBe("/explicit");
    expect(configDirectory({ XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\AppData" })).toBe(join("/xdg", "maccabi-mcp"));
    expect(configDirectory({ APPDATA: "C:\\AppData" })).toBe(windows ? join("C:\\AppData", "maccabi-mcp") : join(homedir(), ".config", "maccabi-mcp"));
    expect(configDirectory({})).toBe(join(homedir(), ".config", "maccabi-mcp"));
  });
});

test("real executable help and rejected secret arguments require neither storage nor network", () => {
  const main = new URL("../../../dist/cli.js", import.meta.url).pathname;
  const help = spawnSync(process.execPath, [main, "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout.toString()).toContain("maccabi login");
  const rejected = spawnSync(process.execPath, [main, "profile", "--otp", "synthetic-secret", "--json"]);
  expect(rejected.status).toBe(2);
  expect(rejected.stderr.toString()).not.toContain("synthetic-secret");
  expect(rejected.stdout.toString()).toBe("");
  expect(JSON.parse(rejected.stderr.toString()).error.code).toBe("INVALID_USAGE");
  const login = spawnSync(process.execPath, [main, "login"], { stdio: ["ignore", "pipe", "pipe"] });
  expect(login.status).toBe(3);
  expect(login.stdout.toString()).toBe("");
  expect(login.stderr.toString()).toContain("interactive terminal");
  const discovery = spawnSync(process.execPath, [main, "help", "--json"]);
  expect(discovery.status).toBe(0);
  expect(JSON.parse(discovery.stdout.toString()).commands.some((command: { name: string }) => command.name === "labs")).toBe(true);
  const version = spawnSync(process.execPath, [main, "--version"]);
  expect(version.status).toBe(0);
  expect(version.stdout.toString()).toBe("maccabi 0.1.0\n");
});

describe("anonymous public directory CLI", () => {
  test("directory discovery/search/detail preserve public data without account storage or clients", async () => {
    const reference = "provider-" + "a".repeat(32);
    const catalog = { data: [{ field: "synthetic-key", label: "תחום לדוגמה" }], retrievedAt: "2026-01-01T00:00:00Z", source: { service: "PublicDirectory", operation: "provider-fields", completeness: "upstream-response" as const } };
    const cities = { ...catalog, data: [{ city: "synthetic-city", label: "עיר סינתטית" }] };
    for (const category of ["doctors", "labs-and-therapists"] as const) {
      const options = { city: "synthetic-city", name: "שם סינתטי", page: 2 };
      const search = { ...catalog, data: { category, field: catalog.data[0]!, providers: [], selection: { category, field: "synthetic-key", options }, filters: { city: cities.data[0]!, name: options.name }, coverage: { page: 2, returned: 0, reportedTotalItems: 120, reportedTotalPages: 12, pagingSupported: true as const } } };
      const detail = { ...catalog, data: { reference, First_Name: "שם סינתטי", ContactDetails: [], Schedules: [] } as any };
      for (const command of ["directory-fields", "directory-cities", "directory-search", "directory-detail"]) {
        const f = fixture(null); let creations = 0;
        f.deps.createAuth = () => { throw new Error("Must not construct auth"); };
        f.deps.connect = async () => { throw new Error("Must not construct owner client"); };
        f.deps.createDirectory = () => { creations++; return {
          listProviderFields: async selected => { expect(selected).toBe(category); return catalog; },
          listProviderCities: async selected => { expect(selected).toBe(category); return cities; },
          searchProviders: async (...args) => { expect(args).toEqual([category, "synthetic-key", options]); return search; },
          getProviderDetails: async (...args) => { expect(args).toEqual([category, "synthetic-key", reference, options]); return detail; },
        }; };
        const selection = ["directory-search", "directory-detail"].includes(command) ? ["--field", "synthetic-key", "--city", options.city, "--name", options.name, "--page", "2"] : [];
        expect(await runCli([command, "--category", category, ...selection, ...(command === "directory-detail" ? ["--reference", reference] : []), "--json", "--no-input"], f.deps)).toBe(0);
        expect(JSON.parse(f.output())).toEqual(command === "directory-detail" ? detail : command === "directory-search" ? search : command === "directory-cities" ? cities : catalog);
        expect(f.calls).toEqual([]); expect(f.prompts).toEqual([]); expect(creations).toBe(1); expect(f.error()).toBe("");
      }
    }
  });
  test("directory invalid inputs and errors never read or delete saved owner state", async () => {
    for (const args of [[], ["--field", "a,b"], ["--field", "two keys"], ["--field", "a", "--owner", "forbidden"], ["--field", "a", "--page", "0"], ["--field", "a", "--page", "1001"], ["--field", "a", "--city", "two cities"], ["--field", "a", "--name", " "], ["--field", "a", "--name", "x".repeat(201)], ["--field", "a", "--name", "invalid\nname"]]) {
      const f = fixture(); f.deps.createDirectory = () => { throw new Error("Must not construct"); };
      expect(await runCli(["directory-search", "--category", "doctors", ...args, "--json"], f.deps)).toBe(2); expect(f.calls).toEqual([]);
    }
    for (const argv of [["directory-fields"], ["directory-cities", "--category", "invented"], ["directory-detail", "--category", "doctors", "--field", "a", "--reference", "malformed"], ["doctor-search", "--field", "a"]]) {
      const f = fixture(); expect(await runCli([...argv, "--json"], f.deps)).toBe(2); expect(f.calls).toEqual([]);
    }
    for (const error of [new UpstreamError("DIRECTORY_UNKNOWN_FIELD"), new ReauthenticationRequired(401)]) {
      const f = fixture(); const fail = async (): Promise<never> => { throw error; };
      f.deps.createDirectory = () => ({ listProviderFields: fail, listProviderCities: fail, searchProviders: fail, getProviderDetails: fail });
      for (const command of ["directory-search", "directory-detail"]) {
        expect(await runCli([command, "--category", "doctors", "--field", "synthetic-key", ...(command === "directory-detail" ? ["--reference", "provider-" + "a".repeat(32)] : []), "--json"], f.deps)).toBe(1);
        expect(f.calls).toEqual([]); expect(f.stored()).toEqual(saved); expect(f.output()).toBe("");
      }
    }
  });
});

test("anonymous directory configuration error gives safe browser guidance without touching saved state", async () => {
  const f = fixture(); const fail = async (): Promise<never> => { throw new UpstreamError("DIRECTORY_CONFIGURATION_UNAVAILABLE"); };
  f.deps.createDirectory = () => ({ listProviderFields: fail, listProviderCities: fail, searchProviders: fail, getProviderDetails: fail });
  expect(await runCli(["directory-search", "--category", "doctors", "--field", "synthetic-key", "--json"], f.deps)).toBe(1);
  const error = JSON.parse(f.error()).error;
  expect(error.code).toBe("DIRECTORY_CONFIGURATION_UNAVAILABLE"); expect(error.exitCode).toBe(1);
  expect(error.message).toContain("bot-challenge page"); expect(error.message).toContain("official directory in a browser"); expect(error.message).toContain("no search was submitted");
  expect(f.output()).toBe(""); expect(f.calls).toEqual([]); expect(f.stored()).toEqual(saved);
});

test("read failures carry per-code guidance that names the operation that failed", async () => {
  const messages = new Map<string, string>();
  for (const [code, operation] of [["OWNER_MISMATCH", "lab-result"], ["UNSUPPORTED_FLOW", "recent-providers"]] as const) {
    const f = fixture();
    f.deps.connect = async () => { throw new ReadOperationError(code, operation); };
    expect(await runCli(["profile", "--json"], f.deps)).toBe(1);
    const error = JSON.parse(f.error()).error;
    expect(error.code).toBe(code);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain(operation);
    expect(f.stored()).toEqual(saved);
    messages.set(code, error.message);
  }
  expect(messages.get("OWNER_MISMATCH")).not.toBe(messages.get("UNSUPPORTED_FLOW"));
  expect(messages.get("OWNER_MISMATCH")).toContain("Re-run the originating list");
  expect(messages.get("UNSUPPORTED_FLOW")).toContain("require an adult account");
});

describe("imaging viewer commands", () => {
  const STUDY = "1.2.826.0.1.3680043.8.498.10000000000001.1700000000.1000001";
  const SERIES = "1.2.826.0.1.3680043.8.498.20000000000002.1700000000.2001";
  const SOP = "1.2.826.0.1.3680043.8.498.30000000000003.1700000000.3001";
  const pixels = new Uint8Array(24).fill(0x45);
  function imaging() {
    const base = fixture();
    const asked: unknown[][] = [];
    const written: { path: string; bytes: Uint8Array }[] = [];
    const readers = {
      currentOwner: owner,
      listImagingStudies: async () => { asked.push(["list"]); return { data: [{ request_id: STUDY, type: "imaging_study" }], source: { operation: "imaging-studies" } }; },
      getImagingStudy: async (study: string) => { asked.push(["study", study]); return { data: { studyInstanceUID: study, mainModality: "US", series: [] }, source: { operation: "imaging-study" } }; },
      getImagingImage: async (...args: string[]) => { asked.push(["image", ...args]); return { data: { rows: 4, columns: 3 }, source: { operation: "imaging-image" } }; },
      getImagingImageThumbnail: async (...args: string[]) => { asked.push(["thumbnail", ...args]); return { data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), retrievedAt: "2026-01-01T00:00:00.000Z", source: { operation: "imaging-thumbnail" } }; },
      getImagingImagePixels: async (...args: string[]) => { asked.push(["pixels", ...args]); return { data: { pixels, rows: 4, columns: 3, samplesPerPixel: 1, bitsAllocated: 16, numberOfFrames: 1, bytesPerFrame: 24, expectedBytes: 24, transferSyntaxUID: "1.2.840.10008.1.2.1" }, retrievedAt: "2026-01-01T00:00:00.000Z", source: { operation: "imaging-pixels" } }; },
    } as unknown as Connected["readers"];
    const deps: CliDependencies = {
      ...base.deps,
      connect: async () => ({ readers, exportSession: async () => session }),
      savePdf: async (path, bytes) => { written.push({ path, bytes }); },
    };
    return { ...base, deps, asked, written };
  }

  test("the five commands pass through the UIDs the previous command returned", async () => {
    const f = imaging();
    expect(await runCli(["imaging-studies", "--json"], f.deps)).toBe(0);
    expect(await runCli(["imaging-study", "--study", STUDY, "--json"], f.deps)).toBe(0);
    expect(await runCli(["imaging-image", "--study", STUDY, "--series", SERIES, "--image", SOP, "--json"], f.deps)).toBe(0);
    expect(f.asked).toEqual([["list"], ["study", STUDY], ["image", STUDY, SERIES, SOP]]);
    expect(JSON.parse(f.output().trim().split("\n")[0]!).data[0].request_id).toBe(STUDY);
  });

  /** Image bytes go to a private file. Nothing binary is ever printed. */
  test("the thumbnail is written to the file and only its size is reported", async () => {
    const f = imaging();
    expect(await runCli(["imaging-thumbnail", "--study", STUDY, "--series", SERIES, "--image", SOP, "--out", "/synthetic/out.jpg", "--json"], f.deps)).toBe(0);
    expect(f.written).toEqual([{ path: "/synthetic/out.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }]);
    const result = JSON.parse(f.output());
    expect(result).toMatchObject({ status: "saved", mimeType: "image/jpeg", bytes: 4 });
    expect(f.output()).not.toContain("255");
  });

  /**
   * The buffer has no header, so the geometry beside it is the difference between a readable file and
   * 24 anonymous bytes. It has to be printed, and the bytes themselves must not be.
   */
  test("the pixel buffer is written to the file while its geometry is printed", async () => {
    const f = imaging();
    expect(await runCli(["imaging-pixels", "--study", STUDY, "--series", SERIES, "--image", SOP, "--out", "/synthetic/out.raw", "--json"], f.deps)).toBe(0);
    expect(f.written[0]!.bytes).toBe(pixels);
    const result = JSON.parse(f.output());
    expect(result).toMatchObject({ status: "saved", mimeType: "application/octet-stream", bytes: 24 });
    expect(result.geometry).toEqual({ rows: 4, columns: 3, samplesPerPixel: 1, bitsAllocated: 16, numberOfFrames: 1, bytesPerFrame: 24, expectedBytes: 24, transferSyntaxUID: "1.2.840.10008.1.2.1" });
    expect(result.geometry.pixels).toBeUndefined();
  });

  test("a missing or malformed UID is a usage error before any session is touched", async () => {
    for (const argv of [
      ["imaging-study", "--json"],
      ["imaging-image", "--study", STUDY, "--json"],
      ["imaging-pixels", "--study", STUDY, "--series", SERIES, "--image", SOP, "--json"],
      ["imaging-study", "--study", "not-a-uid", "--json"],
      ["imaging-study", "--study", "1.2.3/../../etc", "--json"],
      ["imaging-image", "--study", STUDY, "--series", SERIES, "--image", "1.".repeat(40), "--json"],
    ]) {
      const f = imaging();
      expect(await runCli(argv, f.deps)).toBe(2);
      expect(JSON.parse(f.error()).error.code).toBe("INVALID_USAGE");
      expect(f.asked).toEqual([]);
      expect(f.calls).toEqual([]);
    }
  });

  test("discovery lists them and is precise about what the live run did and did not settle", async () => {
    const f = imaging();
    expect(await runCli(["help", "--json"], f.deps)).toBe(0);
    const discovery = JSON.parse(f.output());
    const names = discovery.commands.map((command: { name: string }) => command.name);
    for (const name of ["imaging-studies", "imaging-study", "imaging-image", "imaging-thumbnail", "imaging-pixels"]) expect(names).toContain(name);
    expect(discovery.limitations.join(" ")).toContain("run live against that viewer end to end");
    expect(discovery.limitations.join(" ")).toContain("Only 8-bit ultrasound is evidenced");
    // The live run did not produce an error, so the mappings are still guesses and must still say so.
    expect(discovery.limitations.join(" ")).toContain("no viewer error response was ever captured");
  });
});
