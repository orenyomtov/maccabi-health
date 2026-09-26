import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ISSUES_URL, MaccabiDirectory, MaccabiTransport, ReadOperationError, ReauthenticationRequired, UpstreamError, type MaccabiSession } from "@maccabi/core";
import { createMaccabiMcpServer, serialExecutor, COVERAGE, COVERAGE_URI, type MaccabiMcpOptions, type SessionLease, type ReaderOperations } from "../src/tools";
import { decodeRef, encodeRef, RefTokenError } from "../src/reference";
/** The token prefix, spelled out here so a change to it fails this file rather than passing silently. */
const PREFIX_MARKER = "mref1_";
import { LoginError, type LoginHandle } from "@maccabi/cli/login";
import { SessionStoreError } from "@maccabi/cli/store";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const owner = { memberId: 123456789, memberIdCode: "0" };
const profile = { member_id: owner.memberId, member_id_code: "0", f_name_hebrew: "דוגמה", l_name_hebrew: "בדיקה", f_name_english: "Example", l_name_english: "Fixture", sex: "synthetic", birth_date: "2000-01-01" };
const bootstrap = () => ({ logged_customer_info: profile, current_customer_info: profile, family_data: [{ token: "family-private" }], token: { success: true, content: "synthetic-upstream-token" } });
async function session(): Promise<MaccabiSession> { const transport = new MaccabiTransport(); transport.markAuthenticated(); transport.setApiToken("synthetic-saved-token"); return transport.exportSession(); }
async function setup(overrides: Partial<MaccabiMcpOptions> = {}) {
  const saved = await session();
  const effects = { loads: 0, saves: 0, invalidates: 0, requests: [] as { path: string; body?: unknown }[] };
  const lease: SessionLease = { session: saved, owner, save: async () => { effects.saves++; }, invalidate: async () => { effects.invalidates++; } };
  // No test may reach the network. A tool that gets as far as building a transport fails loudly here
  // rather than quietly contacting Maccabi, which is how a missing pre-session check would hide.
  const server = createMaccabiMcpServer({ resolveSession: async () => { effects.loads++; return lease; }, fetch: async () => { throw new Error("a test reached the network"); }, ...overrides });
  const client = new Client({ name: "synthetic-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return { client, server, effects, lease };
}
function structured(result: unknown): any { return (result as { structuredContent?: unknown }).structuredContent; }
/** `next` is guidance layered on top of a read, so equality against a reader result compares what is left. */
function withoutNext(value: any): any { const { next, ref, ...rest } = value ?? {}; return rest; }
/** Row tokens are minted by this layer, so comparing rows against reader output drops them. */
function withoutRefs(rows: any[]): any[] { return rows.map(({ ref, ...rest }: any) => rest); }
const ref = encodeRef;
function fakeReaders(overrides: Partial<ReaderOperations>): ReaderOperations { return overrides as ReaderOperations; }
function result<T>(data: T) { return { data, retrievedAt: "2025-01-01T00:00:00Z", source: { service: "synthetic", operation: "synthetic", completeness: "upstream-response" as const } }; }

describe("official SDK in-memory MCP integration", () => {
  test("initialize/listTools/readResource exposes fixed schemas and accurate scheduling annotation without accessing a session", async () => {
    const h = await setup();
    const { tools } = await h.client.listTools();
    expect(tools.length).toBe(38);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      // maccabi_logout deletes the saved session, and replacing it costs the member another SMS, so
      // it is the one tool a client should prompt on. Everything else here only ever adds.
      expect(tool.annotations?.destructiveHint).toBe(tool.name === "maccabi_logout");
      expect(tool.annotations?.readOnlyHint).toBe(!["maccabi_clinic_availability", "maccabi_renew_session", "maccabi_login_start", "maccabi_login_verify", "maccabi_logout"].includes(tool.name));
      expect(JSON.stringify(tool.inputSchema)).not.toContain("member_id");
    }
    const coverage = await h.client.readResource({ uri: COVERAGE_URI });
    expect(JSON.stringify(coverage)).toContain("retention");
    expect(h.effects.loads).toBe(0);
  });
  test("capabilities answers what the server can do and how without a session or an upstream request", async () => {
    const h = await setup({ fetch: async () => { throw new Error("no network in capabilities"); } });
    const answer = structured(await h.client.callTool({ name: "maccabi_capabilities", arguments: {} }));
    expect(answer.howItWorks.join(" ")).toContain("maccabi_detail");
    expect(answer.flows.length).toBeGreaterThan(5);
    // `tool` is the field a caller calls, so each one is a single registered name - not a CLI
    // invocation, and not two names joined by a slash, which is a string no client can call either.
    const names = new Set((await h.client.listTools()).tools.map(tool => tool.name));
    for (const flow of answer.flows) for (const step of flow.steps) expect(names.has(step.tool)).toBe(true);
    expect(answer.rowKinds).toContain("test");
    // Whole, not filtered: coverage.session used to be deleted here because the clinical omit filter
    // treats "session" as a credential field, which made docs/MCP.md's resource-equivalence line false.
    expect(answer.coverage).toEqual(COVERAGE);
    expect(h.effects.loads).toBe(0);
  });
  test("a ref that was edited, invented or taken from the wrong tool fails before any session is resolved", async () => {
    const h = await setup();
    for (const token of ["not-a-ref", "mref1_zzzz", encodeRef("visit", { appointment_id: "synthetic" }).slice(0, -4)]) {
      const result = await h.client.callTool({ name: "maccabi_detail", arguments: { ref: token } });
      // Unconditionally: a token that is accepted returns a read rather than an error, and a guarded
      // assertion would pass silently on exactly the regression this test exists to catch.
      expect(result.isError).toBe(true);
      const response = structured(result);
      if (response?.error) {
        expect(response.error.code).toBe("INVALID_REFERENCE");
        expect(response.error.next[0].tool).toBe("maccabi_capabilities");
      }
    }
    // The decoder's own boundaries, below the argument schema that rejects most of the above first.
    // The prefix is what closes the token namespace: without it any base64url payload is a ref.
    const forged = "xxxxxx" + Buffer.from(JSON.stringify(["visit", { appointment_id: "forged" }])).toString("base64url");
    expect(() => decodeRef(forged)).toThrow(RefTokenError);
    expect(decodeRef(PREFIX_MARKER + forged.slice(6)).payload).toEqual({ appointment_id: "forged" });
    // A local reference is a full sha256 or it is not this list's reference.
    for (const reference of ["ab", "a".repeat(63), "a".repeat(65)]) {
      expect(() => decodeRef(encodeRef("certificate", { reference, from: "2026-01-01", to: "2026-12-31" } as never))).toThrow(RefTokenError);
    }
    expect(decodeRef(encodeRef("certificate", { reference: "a".repeat(64), from: "2026-01-01", to: "2026-12-31" })).kind).toBe("certificate");
    // A well-formed ref for a row that carries only a document says so, and names the tool that has it.
    const certificate = structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("certificate", { reference: "a".repeat(64), from: "2026-01-01", to: "2026-12-31" }) } }));
    expect(certificate.error.code).toBe("INVALID_SELECTION");
    expect(certificate.error.instruction).toContain("maccabi_document");
    const study = structured(await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("imaging_study", { study_instance_uid: "1.2.3" }) } }));
    expect(study.error.instruction).toContain("maccabi_detail");
  });

  /**
   * A schema is the whole of what a model has to plan against, so a selector that is accepted and then
   * dropped is the one failure it cannot route around: the download succeeds and hands back the row's
   * default document instead. Every unsupported pair is refused by name, from the ref alone.
   */
  test("a document selector the row cannot use is refused before any session, not dropped", async () => {
    const sha = "a".repeat(64), range = { from: "2026-01-01", to: "2026-12-31" };
    const rows = [
      ["test", ref("test", { request_id: "r", doc_id: "d" }), ["variant", "irregular_only"]],
      ["latest_labs", ref("latest_labs", {}), ["variant"]],
      ["followed_labs", ref("followed_labs", {}), ["variant"]],
      ["visit", ref("visit", { appointment_id: "a" }), ["variant", "reference"]],
      ["inquiry", ref("inquiry", { request_id: "r" }), ["reference"]],
      ["administrative_request", ref("administrative_request", { interaction_id: "i" }), ["reference"]],
      ["mailing", ref("mailing", range), ["reference"]],
      ["prescription", ref("prescription", { doc_id: "d" }), []],
      ["referral", ref("referral", { referral_id: "r" }), []],
      ["certificate", ref("certificate", { reference: sha, ...range }), []],
      ["additional_information", ref("additional_information", { reference: sha, ...range }), []],
      ["hospital_report", ref("hospital_report", { reference: sha, as_of: "2026-09-20" }), []],
      ["billing_report", ref("billing_report", { reference: sha, period: "1001" }), []],
      ["nursing_insurance_report", ref("nursing_insurance_report", { reference: sha }), []],
    ] as const;
    const values = { variant: "summary", reference: "c".repeat(64), irregular_only: true };
    const h = await setup();
    for (const [kind, token, accepted] of rows) {
      for (const selector of ["variant", "reference", "irregular_only"] as const) {
        if ((accepted as readonly string[]).includes(selector)) continue;
        const error = structured(await h.client.callTool({ name: "maccabi_document", arguments: { ref: token, [selector]: values[selector] } })).error;
        expect([kind, selector, error.code]).toEqual([kind, selector, "INVALID_SELECTION"]);
        expect(error.instruction).toContain(selector);
        expect(error.instruction).toContain(accepted.length === 0 ? "exactly one document" : "It takes");
      }
    }
    // irregular_only is the source's print checkbox on a whole report, so it needs the report variant.
    const stray = structured(await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("test", { request_id: "r", doc_id: "d" }), irregular_only: true } })).error;
    expect(stray.instruction).toContain("variant=laboratory_report");
    // A visit offers a summary or one attachment; asking for both names no single document.
    const both = structured(await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("visit", { appointment_id: "a" }), variant: "summary", reference: sha } })).error;
    expect(both.instruction).toContain("not both");
    expect(h.effects.loads).toBe(0);
  });

  test("a mailing reference cannot redirect the download to another row's document", async () => {
    const saved = await session();
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const own = "a".repeat(64), foreign = "b".repeat(64);
    const asked: string[] = [];
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getNotificationPdf: async (reference, dates) => { expect(dates).toEqual(range); asked.push(reference); return result(new TextEncoder().encode("%PDF-1.4 synthetic")); } }), exportSession: async () => saved }) });
    // A type-1 or type-2 row carries its own reference, so a reference copied from another row is
    // refused rather than winning over it and downloading that other row's document.
    const refused = structured(await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("mailing", { ...range, reference: own }), reference: foreign } })).error;
    expect(refused.code).toBe("INVALID_SELECTION");
    expect(refused.instruction).toContain("carries its own document reference");
    await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("mailing", { ...range, reference: own }) } });
    // A type-3 row carries none, and there `reference` is how one of its tutorials is named.
    await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("mailing", range), reference: foreign } });
    expect(asked).toEqual([own, foreign]);
  });

  test("offset and limit are refused on a detail that is one record, and default on the two that are rows", async () => {
    const h = await setup();
    for (const token of [ref("test", { request_id: "r", doc_id: "d" }), ref("visit", { appointment_id: "a" }), ref("inquiry", { request_id: "r" }),
      ref("administrative_request", { interaction_id: "i" }), ref("appointment", { reference: "a".repeat(64) }),
      ref("provider", { object_type: "1", object_id: "2", employee_id: "3" }), ref("imaging_study", { study_instance_uid: "1.2.3" }),
      ref("directory_provider", { category: "doctors", field: "a", reference: "provider-" + "a".repeat(32) })]) {
      for (const bounds of [{ offset: 0 }, { limit: 5 }]) {
        const error = structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: token, ...bounds } })).error;
        expect(error.code).toBe("INVALID_SELECTION");
        expect(error.instruction).toContain("returned whole");
      }
    }
    expect(h.effects.loads).toBe(0);
    // The pair no longer carries a schema default, so the two kinds that page apply it themselves.
    const saved = await session();
    const doses = Array.from({ length: 25 }, (_, index) => ({ dose_number: index }));
    const paged = await setup({ connect: async () => ({ readers: fakeReaders({ getVaccinationDoses: async () => result(doses) }), exportSession: async () => saved }) });
    const answer = structured(await paged.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("vaccination_group", { vaccine_group_code: 1 }) } }));
    expect(answer.page).toMatchObject({ offset: 0, returned: 20, nextOffset: 20 });
  });
  test("real core via injected fetch returns owner profile without identity/credentials and saves refreshed session", async () => {
    let network = 0; let saves = 0;
    const saved = await session();
    const h = await setup({ resolveSession: async () => ({ session: saved, owner, save: async next => { saves++; expect(next.apiAuthorization).toBe("Bearer synthetic-upstream-token"); }, invalidate: async () => {} }), fetch: async () => { network++; return Response.json(bootstrap()); } });
    const response = await h.client.callTool({ name: "maccabi_account", arguments: { section: "profile" } });
    expect(structured(response).data.f_name_hebrew).toBe("דוגמה");
    expect(JSON.stringify(response)).not.toContain(String(owner.memberId));
    expect(JSON.stringify(response)).not.toContain("synthetic-upstream-token");
    expect(JSON.stringify(response)).not.toContain("family-private");
    expect(network).toBe(1); expect(saves).toBe(1);
  });
  test("prescription filters preserve explicit false and subset provenance", async () => {
    const saved = await session();
    const rows = [{ doc_id: "synthetic", drug_name: "מקור", drug_instructions: "הוראה", from_date: "2026-01-01", to_date: "2026-02-01" }];
    const original = { ...result(rows), source: { ...result(rows).source, completeness: "local-filtered-subset" as const } };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listPrescriptions: async options => { expect(options).toEqual({ status: "renewable", permanent: false }); return original; } }), exportSession: async () => saved }) });
    const response = structured(await h.client.callTool({ name: "maccabi_prescriptions", arguments: { status: "renewable", permanent: false } }));
    expect(withoutRefs(response.data)).toEqual(rows); expect(response.source).toEqual(original.source);
    // The row's own token is what the prescription PDF and its alternatives are then reached with.
    expect(response.data[0].ref).toBe(ref("prescription", { doc_id: "synthetic" }));
    expect(response.next).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "maccabi_document", arguments: { ref: response.data[0].ref } })]));
    const invalid = await setup();
    for (const args of [{ status: "invented" }, { permanent: "false" }, { renew: true }]) expect((await invalid.client.callTool({ name: "maccabi_prescriptions", arguments: args })).isError).toBe(true);
    expect(invalid.effects.loads).toBe(0);
  });

  test("comparison latest/followed selection is exact and rejects conflicting inputs", async () => {
    const saved = await session();
    for (const source of ["latest", "followed"] as const) {
      const token = ref(source === "latest" ? "latest_labs" : "followed_labs", {});
      const pdf = async (selection: unknown) => { expect(selection).toEqual({ source, testId: "synthetic-test" }); return result(new TextEncoder().encode("%PDF-synthetic")); };
      const h = await setup({ connect: async () => ({ readers: fakeReaders({ getLabComparison: async selection => { expect(selection).toEqual({ source, testId: "synthetic-test" }); return result({ current_result: {} as any, other_results: [] }); }, getLabComparisonPdf: pdf, getLabResultFilePdf: pdf }), exportSession: async () => saved }) });
      expect((await h.client.callTool({ name: "maccabi_detail", arguments: { ref: token, test_id: "synthetic-test" } })).isError).not.toBe(true);
      for (const variant of [undefined, "comparison_list"]) expect((await h.client.callTool({ name: "maccabi_document", arguments: { ref: token, test_id: "synthetic-test", ...(variant ? { variant } : {}) } })).isError).not.toBe(true);
      const invalid = await setup();
      // request_id/doc_id are no longer arguments at all, so the mismatched pair this once guarded against is unspeakable.
      expect((await invalid.client.callTool({ name: "maccabi_detail", arguments: { ref: token, test_id: "synthetic-test", request_id: "forbidden", doc_id: "forbidden" } })).isError).toBe(true);
      // A latest/followed view is a whole view: without test_id there is no analyte to compare, and saying so costs no session.
      expect(structured(await invalid.client.callTool({ name: "maccabi_detail", arguments: { ref: token } })).error.code).toBe("INVALID_SELECTION");
      expect(invalid.effects.loads).toBe(0);
    }
  });

  test("followed labs retain complete envelope and reject follow-state inputs", async () => {
    const saved = await session();
    const original = result({ followed_counter: 0, followed_tests: [], options: [{ test_id: 1, test_desc: "מקור", is_follow: false }] });
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listFollowedLabResults: async () => original }), exportSession: async () => saved }) });
    const envelope = structured(await h.client.callTool({ name: "maccabi_followed_labs", arguments: {} }));
    expect(withoutNext(envelope)).toEqual(original);
    expect(envelope.ref).toBe(ref("followed_labs", {}));
    const invalid = await setup();
    expect((await invalid.client.callTool({ name: "maccabi_followed_labs", arguments: { is_follow: true } })).isError).toBe(true);
    expect((await invalid.client.callTool({ name: "maccabi_report", arguments: { document: "followed_labs", is_follow: true } })).isError).toBe(true);
    expect(invalid.effects.loads).toBe(0);
  });

  test("nested known metadata is omitted while original clinical prose, units and values remain unchanged", async () => {
    const saved = await session();
    const original = "טקסט קליני מקורי 123456789 ללא שינוי";
    const row = { doc_id: "fixture-doc", drug_name: "תרופה", drug_instructions: "טקסט מקור", from_date: "source-from", to_date: "source-to", clinical_text: original, nested: { patient_id: "private-patient", member_id_code: "private-code", Authorization: "private-auth", session_id: "private-session", hash: "private-signature", pdf_link: "private-url", result: 4.25, units: "mmol/L" } };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listPrescriptions: async () => result([row]) }), exportSession: async () => saved }) });
    const response = await h.client.callTool({ name: "maccabi_prescriptions", arguments: {} });
    const data = structured(response).data[0];
    expect(data.clinical_text).toBe(original);
    expect(data.nested).toEqual({ result: 4.25, units: "mmol/L" });
    expect(JSON.stringify(response)).not.toContain("private-");
  });
  test("nursing catalog and administrative common coverage remain intact; alternatives page locally", async () => {
    const saved = await session();
    const catalog = result({ reports: [{ period: "2025", productionDate: "2026-01-01", viewLabel: "צפייה", reference: "a".repeat(64) }], pagination: { returned: 1, reportedResultCount: 1, totalPages: 1, currentPage: 1 as const } });
    const detail = result({ classification: "Case" as const, coverage: "common" as const, body: "טקסט מקור", messages: [], attachments: [{ file_name: null, reference: "a".repeat(64) }], obligation_details: { treatments: [{ treatment_name: "מקור" }] }, decision: { kind: "refund" as const, print_decision_message: "טקסט מקור" }, unsupported_sections: ["extended_properties" as const] });
    const alternatives = result([{ largo_code: 123, name: "מקור" }, { largo_code: "second", name: "נוסף" }]);
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listNursingInsuranceReports: async () => catalog, getAdministrativeRequest: async id => { expect(id).toBe("synthetic"); return detail; }, listPrescriptionAlternatives: async id => { expect(id).toBe("synthetic"); return alternatives; } }), exportSession: async () => saved }) });
    const nursing = structured(await h.client.callTool({ name: "maccabi_nursing_insurance_reports", arguments: {} }));
    expect(withoutNext(nursing).data.reports).toEqual([{ ...catalog.data.reports[0], ref: ref("nursing_insurance_report", { reference: "a".repeat(64) }) }]);
    expect(withoutNext(nursing).data.pagination).toEqual(catalog.data.pagination);
    expect(withoutNext(structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("administrative_request", { interaction_id: "synthetic" }) } })))).toEqual(detail);
    expect(withoutNext(structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("prescription", { doc_id: "synthetic" }), limit: 1 } }))).data).toEqual([alternatives.data[0]]);
    const invalid = await setup();
    for (const [name, args] of [["maccabi_nursing_insurance_reports", { period: "2025" }],
      ["maccabi_document", { ref: ref("nursing_insurance_report", { reference: "a".repeat(64) }), reference: "malformed" }],
      ["maccabi_detail", { ref: ref("administrative_request", { interaction_id: "synthetic" }), classification: "Case" }],
      ["maccabi_document", { ref: ref("administrative_request", { interaction_id: "synthetic" }), reference: "malformed" }],
      ["maccabi_detail", { ref: ref("prescription", { doc_id: "synthetic" }), largo_code: 123 }]] as const) expect((await invalid.client.callTool({ name, arguments: args })).isError).toBe(true);
    expect(invalid.effects.loads).toBe(0);
  });
  test("local pagination advertises explicit subset boundaries and year reaches the core reader without invented upstream options", async () => {
    const saved = await session(); let options: unknown;
    const rows = Array.from({ length: 55 }, (_, index) => ({ request_id: `fixture-${index}`, execute_date: "2025-01-01T00:00:00" }));
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listTests: async o => { options = o; return result({ categories: [], tests: rows as any }); } }), exportSession: async () => saved }) });
    const response = await h.client.callTool({ name: "maccabi_tests", arguments: { year: 2025, offset: 20, limit: 10 } });
    expect(options).toEqual({ year: 2025 });
    expect(structured(response).data).toEqual(rows.slice(20, 30));
    expect(structured(response).page).toEqual({ offset: 20, returned: 10, totalInUpstreamResponse: 55, nextOffset: 30, truncated: true, strategy: "local-response-offset", completeHistory: false });
  });
  test("invalid or extra credential arguments fail before resolving any session", async () => {
    const h = await setup();
    for (const args of [{ limit: 51 }, { otp: "never-send" }, { offset: -1 }]) {
      const response = await h.client.callTool({ name: "maccabi_prescriptions", arguments: args });
      expect((response as any).isError).toBe(true);
    }
    expect(h.effects.loads).toBe(0);
  });
  test("latest labs lead to comparison history beyond the summary list without changing source values", async () => {
    const saved = await session();
    const row = { test_id: "synthetic-test", test_desc: "מקור", units: "mmol/L", message: "טקסט מקור", message_list: [], lab_date: "2026-01-01", min_lim: 1, max_lim: 6, result: 4.25, numeric_percentage: 50, is_messages: "N", is_vitek: false, is_follow: true, vitek_row: [], has_result_file: false };
    const groups = [{ group_name: "מקור", group_values: [row] }, { group_name: "נוסף", group_values: [] }];
    const current = { ...row, doc_first_name: "שם", doc_last_name: "סינתטי", is_graph: true };
    const comparison = { current_result: current, other_results: [{ ...current, lab_date: "2018-03-04", result: 3.75, min_lim: 1.25, max_lim: 5.5 }] };
    const selections: unknown[] = [];
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listLatestLabResults: async () => result(groups), getLabComparison: async selection => { selections.push(selection); return result(comparison); } }), exportSession: async () => saved }) });
    const latest = structured(await h.client.callTool({ name: "maccabi_latest_labs", arguments: { limit: 1 } }));
    expect(latest.data).toEqual([groups[0]]);
    expect(latest.page.completeHistory).toBe(false);
    // The result names its own view, and its next step is that view's ref plus an analyte from it.
    expect(latest.ref).toBe(ref("latest_labs", {}));
    expect(latest.next).toEqual(expect.arrayContaining([{ tool: "maccabi_detail", arguments: { ref: latest.ref, test_id: "synthetic-test" }, why: expect.any(String) }]));
    expect(withoutNext(structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: latest.ref, test_id: latest.data[0].group_values[0].test_id } }))).data).toEqual(comparison);
    const testRef = ref("test", { request_id: "synthetic-request", doc_id: "synthetic-doc" });
    expect(withoutNext(structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: testRef, test_id: "synthetic-test" } }))).data).toEqual(comparison);
    expect(selections).toEqual([{ source: "latest", testId: "synthetic-test" }, { source: "result", requestId: "synthetic-request", docId: "synthetic-doc", testId: "synthetic-test" }]);
    for (const [name, args] of [["maccabi_latest_labs", { owner: "forbidden" }], ["maccabi_report", { document: "latest_labs", date: "2026-01-01" }], ["maccabi_detail", { ref: testRef, test_id: "synthetic-test", date: "2026-01-01" }], ["maccabi_document", { ref: testRef, request_id: "synthetic-request" }]] as const) {
      const invalid = await setup();
      expect((await invalid.client.callTool({ name, arguments: args })).isError).toBe(true);
      expect(invalid.effects.loads).toBe(0);
    }
  });

  test("future appointment display projection retains source evidence, nulls and original text", async () => {
    const saved = await session();
    const row = { date: "2026-10-01T10:00:00", provider_name: "שם סינתטי", provider_service_type: "מקור", description: "טקסט מקורי 123456789", category_visit_type: null, ascribed_doctor: null, ascribed_doctor_gender: null, subsidiary_name: null, facility_category: null, follow_up_appointments_count: null, waiting_list_status: null, provider_role: null };
    const original = { ...result([row, row]), source: { ...result([]).source, schemaEvidence: "frontend-field-projection" as const } };
    const detail = { ...original, data: { appointment: row, provider: { address: "כתובת סינתטית", order_appointment_phone: null, phone: null, fax: null }, instructions: [{ description: "הוראה מקורית", link: "https://example.invalid/instructions" }] } };
    const reference = "a".repeat(64);
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listFutureAppointments: async () => original, getFutureAppointment: async value => { expect(value).toBe(reference); return detail; } }), exportSession: async () => saved }) });
    const response = structured(await h.client.callTool({ name: "maccabi_upcoming_appointments", arguments: { limit: 1 } }));
    expect(withoutRefs(response.data)).toEqual([row]);
    expect(response.source).toEqual(original.source);
    expect(response.page.completeHistory).toBe(false);
    // A row with no source reference has nothing to open, so it is handed no token either.
    expect(response.data[0].ref).toBeUndefined();
    const appointmentRef = ref("appointment", { reference });
    expect(withoutNext(structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: appointmentRef } })))).toEqual(detail);
    const invalid = await setup();
    for (const args of [{ ref: "malformed" }, { ref: appointmentRef, owner: "forbidden" }, { ref: ref("appointment", { reference: "malformed" }) }]) expect((await invalid.client.callTool({ name: "maccabi_detail", arguments: args })).isError).toBe(true);
    expect(invalid.effects.loads).toBe(0);
  });
  test("upstream reauthentication invalidates once and is a tool error with protected browser guidance", async () => {
    const saved = await session(); let invalidates = 0;
    const h = await setup({ resolveSession: async () => ({ session: saved, owner, save: async () => {}, invalidate: async () => { invalidates++; }, reauthentication: { url: "https://personal.example/reauth", instruction: "Open the protected sign-in page." } }), connect: async () => { throw new ReauthenticationRequired(); } });
    const response = await h.client.callTool({ name: "maccabi_account", arguments: { section: "profile" } });
    expect((response as any).isError).toBe(true);
    expect(structured(response).error).toEqual({ code: "REAUTHENTICATION_REQUIRED", instruction: "Open the protected sign-in page.", reauthenticationUrl: "https://personal.example/reauth", next: expect.any(Array) });
    expect(structured(response).error.next[0].tool).toBe("maccabi_login_status");
    expect(invalidates).toBe(1);
  });
  test("invalidation failure is distinct; neither a selected dependent nor an ordinary reference mismatch invalidates", async () => {
    const saved = await session();
    for (const scenario of ["invalidation-fails", "account", "detail"] as const) {
      let invalidates = 0;
      const h = await setup({ resolveSession: async () => ({ session: saved, owner, save: async () => {}, invalidate: async () => { invalidates++; if (scenario === "invalidation-fails") throw new Error("secret-storage-message"); } }), connect: async () => {
        if (scenario === "invalidation-fails") throw new ReauthenticationRequired();
        if (scenario === "account") throw new ReadOperationError("DEPENDENT_SELECTED", "account");
        return { readers: fakeReaders({ getVisit: async () => { throw new ReadOperationError("OWNER_MISMATCH", "visit"); } }), exportSession: async () => saved };
      } });
      const response = await h.client.callTool({ name: scenario === "detail" ? "maccabi_detail" : "maccabi_account", arguments: scenario === "detail" ? { ref: ref("visit", { appointment_id: "unknown-fixture" }) } : { section: "profile" } });
      expect(structured(response).error.code).toBe(scenario === "invalidation-fails" ? "SESSION_INVALIDATION_FAILED" : scenario === "account" ? "DEPENDENT_SELECTED" : "OWNER_MISMATCH");
      if (scenario === "account") expect(structured(response).error.instruction).toContain("no new login is needed");
      expect(invalidates).toBe(scenario === "invalidation-fails" ? 1 : 0);
      expect(JSON.stringify(response)).not.toContain("secret-storage-message");
    }
  });
  test("clinical workflow follows every available list page into unchanged lab detail and original report bytes", async () => {
    const saved = await session();
    const rows = Array.from({ length: 55 }, (_, i) => ({ request_id: `request-${i}`, doc_id: `doc-${i}`, type: "lab_result", execute_date: `${2022 + i % 5}-01-02T10:00:00` }));
    const detail = result({ results: [{ test_id: "synthetic-cholesterol", test_name: "כולסטרול", result: "205", units: "mg/dL", min_lim: "0", max_lim: "200", test_date: "2022-01-02" }], is_partial: false });
    const bytes = new TextEncoder().encode("%PDF-1.4\noriginal synthetic laboratory report");
    const h = await setup({ connect: async () => ({ readers: fakeReaders({
      listTests: async options => { expect(options).toEqual({}); return result({ categories: [], tests: rows as any }); },
      getLabResult: async (requestId, docId) => { expect([requestId, docId]).toEqual([rows[0]!.request_id, rows[0]!.doc_id]); return detail as any; },
      getLabReportPdf: async (requestId, docId) => { expect([requestId, docId]).toEqual([rows[0]!.request_id, rows[0]!.doc_id]); return result(bytes); },
    }), exportSession: async () => saved }) });
    const collected: unknown[] = [];
    let offset: number | null = 0;
    for (let calls = 0; offset !== null && calls < 3; calls++) {
      const page = structured(await h.client.callTool({ name: "maccabi_tests", arguments: { offset, limit: 50 } }));
      collected.push(...page.data);
      expect(page.page.completeHistory).toBe(false);
      expect(page.page.totalInUpstreamResponse).toBe(55);
      offset = page.page.nextOffset;
    }
    expect(offset).toBe(null);
    expect(withoutRefs(collected)).toEqual(rows);
    const first = ref("test", { request_id: rows[0]!.request_id, doc_id: rows[0]!.doc_id });
    expect((collected[0] as any).ref).toBe(first);
    expect(withoutNext(structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: first } })))).toEqual(detail);
    const pdf = await h.client.callTool({ name: "maccabi_document", arguments: { ref: first, variant: "laboratory_report" } });
    const resource = (pdf as any).content.find((item: any) => item.type === "resource").resource;
    expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
    expect(h.effects.saves).toBe(4);
  });

  test("doctor correspondence workflow preserves both remarks and follows only its explicit associated referral", async () => {
    const saved = await session();
    const inquiry = result({ request_id: "inquiry-fixture", patient_remark: "שאלה מקורית", doctor_remark: "תשובת הרופא", creation_date: "2025-01-01", update_date: "2025-01-03", visit_summary: result({ follow_up_details: "הנחיית מעקב מקורית", referrals: [{ referral_id: "referral-fixture", pdf_reference: "b".repeat(64), referral_title_name: "בדיקה סינתטית" }] }) });
    const bytes = new TextEncoder().encode("%PDF-1.4\noriginal synthetic referral");
    const h = await setup({ connect: async () => ({ readers: fakeReaders({
      listInquiries: async () => result([{ request_id: "inquiry-fixture", type: "medical_form_request", service_provider_name: "רופא לדוגמה", request_status: "answered", status_update_date: "2025-01-03" }, { request_id: "automatic-fixture", type: "automatic_sick_permit", service_provider_name: "", request_status: "issued", status_update_date: "2025-01-03", pdf_reference: "c".repeat(64) }]),
      getInquiry: async id => { expect(id).toBe("inquiry-fixture"); return inquiry; },
      getInquiryDocumentPdf: async (requestId, reference) => { expect([requestId, reference]).toEqual(requestId === "automatic-fixture" ? ["automatic-fixture", "c".repeat(64)] : ["inquiry-fixture", "b".repeat(64)]); return result(bytes); },
    }), exportSession: async () => saved }) });
    const list = structured(await h.client.callTool({ name: "maccabi_doctor_inquiries", arguments: {} }));
    const inquiryRef = list.data[0].ref;
    expect(inquiryRef).toBe(ref("inquiry", { request_id: "inquiry-fixture" }));
    const detail = structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: inquiryRef } }));
    expect(withoutNext(detail)).toEqual(inquiry);
    // The detail result points straight at the referral it carries, with the reference already filled in.
    expect(detail.next).toEqual([{ tool: "maccabi_document", arguments: { ref: inquiryRef, reference: "b".repeat(64) }, why: expect.any(String) }]);
    const pdf = await h.client.callTool({ name: "maccabi_document", arguments: { ref: inquiryRef, reference: detail.data.visit_summary.data.referrals[0].pdf_reference } });
    const resource = (pdf as any).content.find((item: any) => item.type === "resource").resource;
    expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
    const automatic = await h.client.callTool({ name: "maccabi_document", arguments: { ref: list.data[1].ref, reference: list.data[1].pdf_reference } });
    expect(automatic.isError).not.toBe(true);
    expect(h.effects.saves).toBe(4);
  });

  test("original PDF is an embedded private resource, bounded and free of public paths or access URLs", async () => {
    const saved = await session();
    const bytes = new TextEncoder().encode("%PDF-1.4\noriginal synthetic document 123456789");
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getReferralPdf: async () => result(bytes) }), exportSession: async () => saved }) });
    const response = await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("referral", { referral_id: "fixture-referral" }) } });
    const resource = (response as any).content.find((item: any) => item.type === "resource").resource;
    expect(resource.uri).toMatch(/^maccabi:\/\/document\/[0-9a-f-]+$/);
    expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
    expect(JSON.stringify(response)).not.toContain("https:");
  });
  test("oversized documents/details fail explicitly and unexpected exception messages stay private", async () => {
    const saved = await session();
    for (const scenario of ["pdf", "json", "unexpected"] as const) {
      const h = await setup({ connect: async () => ({ readers: fakeReaders({ getReferralPdf: async () => result(new Uint8Array(2 * 1024 * 1024 + 1)), getVisit: async () => { if (scenario === "unexpected") throw new Error("secret unexpected response body"); return result({ clinical_text: "x".repeat(150_000) }); } }), exportSession: async () => saved }) });
      const response = await h.client.callTool({ name: scenario === "pdf" ? "maccabi_document" : "maccabi_detail", arguments: { ref: scenario === "pdf" ? ref("referral", { referral_id: "fixture" }) : ref("visit", { appointment_id: "fixture" }) } });
      expect(structured(response).error.code).toBe(scenario === "unexpected" ? "READ_UNAVAILABLE" : "RESULT_TOO_LARGE");
      expect(JSON.stringify(response)).not.toContain("secret unexpected");
    }
  });

  test("protected storage failures report their own code instead of a generic read failure", async () => {
    const saved = await session();
    const readers = fakeReaders({ getVisit: async () => result({ clinical_text: "synthetic" }) });
    // A read can succeed and the session write that follows can still fail; both must say storage, not upstream.
    for (const stage of ["resolve", "save"] as const) {
      const failure = () => { throw new SessionStoreError("/home/example/.config/maccabi-mcp/session.json is not a usable saved session."); };
      const h = await setup({
        resolveSession: async () => { if (stage === "resolve") failure(); return { session: saved, owner, save: async () => failure(), invalidate: async () => {} }; },
        connect: async () => ({ readers, exportSession: async () => saved }),
      });
      const response = await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("visit", { appointment_id: "fixture" }) } });
      expect(response.isError).toBe(true);
      expect(structured(response).error.code).toBe("SESSION_STORE_UNAVAILABLE");
      expect(structured(response).error.code).not.toBe("READ_UNAVAILABLE");
      expect(structured(response).error.instruction).toContain("maccabi config directory");
      expect(JSON.stringify(response)).not.toContain("/home/example");
    }
  });
});

describe("observed billing summaries and medication document", () => {
  test("payment fields omit full instruments while payer totals retain exact aggregate scope and amounts", async () => {
    const saved = await session();
    const totals = { ...result({ kupa_debt: 12.5, shaban_debt: 3, additional_charges_debt: 0 }), source: { ...result({}).source, scope: "payer-account-aggregate" as const } };
    const payment = result({ is_active_auth_exists: true, payment_method: 1, bank_name: "בנק סינתטי", last_four_digits_credit_card: "1234", account_number: "private-full-account", token: "private-token" });
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getPaymentMethods: async () => payment, getOutstandingDebt: async (...args: unknown[]) => { expect(args).toEqual([]); return totals; } }), exportSession: async () => saved }) });
    const summary = structured(await h.client.callTool({ name: "maccabi_account", arguments: { section: "payment_methods" } }));
    expect(summary.data).toEqual({ is_active_auth_exists: true, payment_method: 1, bank_name: "בנק סינתטי", last_four_digits_credit_card: "1234" });
    expect(JSON.stringify(summary)).not.toContain("private-");
    expect(structured(await h.client.callTool({ name: "maccabi_payer_account_totals", arguments: {} }))).toEqual(totals);
    expect(h.effects.saves).toBe(2);
    const coverage = await h.client.readResource({ uri: COVERAGE_URI });
    expect(JSON.stringify(coverage)).toContain("payer-account-aggregate");
  });

  test("financial tools reject identity/branch switching and retain explicit unsupported failures", async () => {
    const saved = await session();
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getOutstandingDebt: async () => { throw new ReadOperationError("UNSUPPORTED_FLOW", "outstanding-debt"); } }), exportSession: async () => saved }) });
    for (const [name, base] of [["maccabi_account", { section: "payment_methods" }], ["maccabi_payer_account_totals", {}]] as const) {
      for (const args of [{ member_id: "never-selected" }, { person_type: 2 }, { path: "/private/never-read" }]) {
        expect((await h.client.callTool({ name, arguments: { ...base, ...args } })).isError).toBe(true);
      }
    }
    // The section enum is the whole selector: a missing or invented one never reaches a reader.
    for (const args of [{}, { section: "invented" }, { section: "payment_methods", document: "allergies" }]) {
      expect((await h.client.callTool({ name: "maccabi_account", arguments: args })).isError).toBe(true);
    }
    for (const args of [{ document: "purchased_medications", member_id: "never-selected" }, { document: "invented" }, { document: "purchased_medications", irregular_only: true }]) {
      expect((await h.client.callTool({ name: "maccabi_report", arguments: args })).isError).toBe(true);
    }
    expect(h.effects.loads).toBe(0);
    expect(structured(await h.client.callTool({ name: "maccabi_payer_account_totals", arguments: {} })).error.code).toBe("UNSUPPORTED_FLOW");
    expect(h.effects.invalidates).toBe(0);
  });

  test("medication report preserves PDF bytes and provenance within the common size bound", async () => {
    const saved = await session();
    for (const oversized of [false, true]) {
      const bytes = oversized ? new Uint8Array(2 * 1024 * 1024 + 1) : new TextEncoder().encode("%PDF-1.4\noriginal synthetic medication report 123456789");
      const original = result(bytes);
      const h = await setup({ connect: async () => ({ readers: fakeReaders({ getMedicationReportPdf: async () => original }), exportSession: async () => saved }) });
      const response = await h.client.callTool({ name: "maccabi_report", arguments: { document: "purchased_medications" } });
      if (oversized) {
        expect(structured(response).error.code).toBe("RESULT_TOO_LARGE");
        expect((response as any).content.some((item: any) => item.type === "resource")).toBe(false);
      } else {
        const resource = (response as any).content.find((item: any) => item.type === "resource").resource;
        expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
        expect(resource.mimeType).toBe("application/pdf");
        expect(structured(response).source).toEqual(original.source);
        expect(structured(response).retrievedAt).toBe(original.retrievedAt);
        expect(structured(response).containsOriginalDocument).toBe(true);
        expect(JSON.stringify(response)).not.toContain("https:");
      }
    }
  });
});

describe("owner-list certificates and imaging documents", () => {
  test("certificate list and PDF use the same date range and path-derived local reference", async () => {
    const saved = await session();
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const reference = "a".repeat(64);
    const rows = [{ reference, title_name: "אישור סינתטי", practitioner_full_name: "דוגמה", specialization_description: "מקור", approval_date: "2026-01-02", approval_date_from: "2026-01-02", approval_date_to: "2026-01-03", approval_type_code: "synthetic" }];
    const bytes = new TextEncoder().encode("%PDF-1.4\noriginal synthetic certificate");
    const original = result(bytes);
    const h = await setup({ connect: async () => ({ readers: fakeReaders({
      listCertificates: async selectedRange => { expect(selectedRange).toEqual(range); return result(rows); },
      getCertificatePdf: async (selectedReference, selectedRange) => { expect(selectedReference).toBe(reference); expect(selectedRange).toEqual(range); return original; },
    }), exportSession: async () => saved }) });
    const list = structured(await h.client.callTool({ name: "maccabi_medical_certificates", arguments: { ...range, limit: 1 } }));
    expect(withoutRefs(list.data)).toEqual(rows);
    expect(list.page.completeHistory).toBe(false);
    // The row's token carries the range as well as the reference, so the download cannot be given a different one.
    expect(list.data[0].ref).toBe(ref("certificate", { reference, ...range }));
    const response = await h.client.callTool({ name: "maccabi_document", arguments: { ref: list.data[0].ref } });
    const resource = (response as any).content.find((item: any) => item.type === "resource").resource;
    expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
    expect(structured(response).source).toEqual(original.source);
  });

  test("required valid date ranges and reference-only schemas fail before session access", async () => {
    const h = await setup();
    for (const name of ["maccabi_medical_certificates", "maccabi_additional_information", "maccabi_mailings"]) {
      for (const args of [{}, { from: "2026-02-30", to: "2026-12-31" }, { from: "2026-12-31", to: "2026-01-01" }, { from: "2026-01-01", to: "2026-12-31", path: "/private/never-read" }]) {
        expect((await h.client.callTool({ name, arguments: args })).isError).toBe(true);
      }
    }
    // A document ref holds its own dates, so an invalid or out-of-order range cannot be smuggled past it either.
    for (const dates of [{ from: "2026-02-30", to: "2026-12-31" }, { from: "2026-12-31", to: "2026-01-01" }]) {
      expect((await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("certificate", { reference: "a".repeat(64), ...dates }) } })).isError).toBe(true);
    }
    expect((await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("certificate", { reference: "malformed", from: "2026-01-01", to: "2026-12-31" }) } })).isError).toBe(true);
    expect((await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("test", { request_id: "synthetic", doc_id: "synthetic" }), member_id: "never-selected" } })).isError).toBe(true);
    expect(h.effects.loads).toBe(0);
  });

  test("additional-information entries preserve source display/evidence fields and bounded date-range selection", async () => {
    const saved = await session();
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const rows = [{ session_datetime: "2026-01-02", type_id: 1, display_text: "מידע סינתטי", practitioner_name: "דוגמה", specialization: "מקור" }];
    const original = { ...result(rows), source: { ...result(rows).source, schemaEvidence: "frontend-field-projection" as const } };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listAdditionalInformation: async selectedRange => { expect(selectedRange).toEqual(range); return original; } }), exportSession: async () => saved }) });
    const response = structured(await h.client.callTool({ name: "maccabi_additional_information", arguments: { ...range, limit: 1 } }));
    expect(withoutRefs(response.data)).toEqual(rows);
    expect(response.source).toEqual(original.source);
    expect(response.page.completeHistory).toBe(false);
    expect(h.effects.saves).toBe(1);
  });

  test("imaging PDF retains original bytes/provenance while both new document tools enforce size bounds", async () => {
    const saved = await session();
    const bytes = new TextEncoder().encode("%PDF-1.4\noriginal synthetic imaging result");
    const original = result(bytes);
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getImagingResultPdf: async (request, doc) => { expect([request, doc]).toEqual(["synthetic-request", "synthetic-doc"]); return original; } }), exportSession: async () => saved }) });
    const response = await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("test", { request_id: "synthetic-request", doc_id: "synthetic-doc" }) } });
    const resource = (response as any).content.find((item: any) => item.type === "resource").resource;
    expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
    expect(structured(response).source).toEqual(original.source);
    const bounded = await setup({ connect: async () => ({ readers: fakeReaders({ getImagingResultPdf: async () => result(new Uint8Array(2 * 1024 * 1024 + 1)), getCertificatePdf: async () => result(new Uint8Array(2 * 1024 * 1024 + 1)) }), exportSession: async () => saved }) });
    expect(structured(await bounded.client.callTool({ name: "maccabi_document", arguments: { ref: ref("test", { request_id: "synthetic-request", doc_id: "synthetic-doc" }) } })).error.code).toBe("RESULT_TOO_LARGE");
    expect(structured(await bounded.client.callTool({ name: "maccabi_document", arguments: { ref: ref("certificate", { reference: "a".repeat(64), from: "2026-01-01", to: "2026-12-31" }) } })).error.code).toBe("RESULT_TOO_LARGE");
  });
});

describe("expanded source-backed medical profile tools", () => {
  test("vaccination groups preserve source labels, counts and dates with local paging and provenance", async () => {
    const saved = await session(); let calls = 0;
    const rows = [
      { vaccine_group_code: 8, vaccinations_amount: 2, vaccine_group_name: "קבוצת חיסון לדוגמה", first_date: "2021-01-02T00:00:00", last_date: "2022-03-04T00:00:00", timestamp: "synthetic-source-timestamp", original_note: "מקור 123456789", member_id: owner.memberId },
      { vaccine_group_code: 9, vaccinations_amount: 1, vaccine_group_name: "קבוצה נוספת", first_date: "2023-05-06T00:00:00", last_date: "2023-05-06T00:00:00", timestamp: "synthetic-source-timestamp" },
    ];
    const original = result(rows);
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listVaccinationGroups: async () => { calls++; return original; } }), exportSession: async () => saved }) });
    const response = await h.client.callTool({ name: "maccabi_vaccinations", arguments: { offset: 0, limit: 1 } });
    expect(response.isError).not.toBe(true);
    expect(withoutRefs(structured(response).data)).toEqual([{ vaccine_group_code: 8, vaccinations_amount: 2, vaccine_group_name: "קבוצת חיסון לדוגמה", first_date: "2021-01-02T00:00:00", last_date: "2022-03-04T00:00:00", timestamp: "synthetic-source-timestamp", original_note: "מקור 123456789" }]);
    expect(structured(response).data[0].ref).toBe(ref("vaccination_group", { vaccine_group_code: 8 }));
    expect(structured(response).source).toEqual(original.source);
    expect(structured(response).retrievedAt).toBe(original.retrievedAt);
    expect(structured(response).page).toMatchObject({ returned: 1, totalInUpstreamResponse: 2, nextOffset: 1, truncated: true, completeHistory: false });
    expect(calls).toBe(1); expect(h.effects.saves).toBe(1);
  });
  test("empty sensitivities retains its source evidence label without a synthetic diagnosis", async () => {
    const saved = await session();
    const original = { ...result([]), source: { ...result([]).source, schemaEvidence: "frontend-field-projection" as const } };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listSensitivities: async () => original }), exportSession: async () => saved }) });
    const response = await h.client.callTool({ name: "maccabi_allergies", arguments: {} });
    expect(response.isError).not.toBe(true);
    expect(structured(response).data).toEqual([]);
    expect(structured(response).source).toEqual(original.source);
    expect(structured(response).page).toMatchObject({ returned: 0, nextOffset: null, completeHistory: false });
    const tools = await h.client.listTools();
    expect(tools.tools.find(tool => tool.name === "maccabi_allergies")?.description).toContain("empty list does not establish absence of allergies");
  });
  test("expanded tools reject owner/credential arguments and fail safely on unsupported source responses", async () => {
    const saved = await session();
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listSensitivities: async () => { throw new ReadOperationError("UNSUPPORTED_FLOW", "sensitivities"); } }), exportSession: async () => saved }) });
    for (const name of ["maccabi_vaccinations", "maccabi_allergies"]) {
      expect((await h.client.callTool({ name, arguments: { member_id: "synthetic-private-identity" } })).isError).toBe(true);
      expect((await h.client.callTool({ name, arguments: { limit: 51 } })).isError).toBe(true);
    }
    expect(h.effects.loads).toBe(0);
    const response = await h.client.callTool({ name: "maccabi_allergies", arguments: {} });
    expect(structured(response).error.code).toBe("UNSUPPORTED_FLOW");
    expect(h.effects.invalidates).toBe(0);
  });
});

describe("existing inquiry and vaccination document tools", () => {
  test("inquiry paging and owner-list reference reach the shared reader without rewriting clinical text", async () => {
    const saved = await session(); let requested: string | undefined;
    const rows = [
      { request_id: "101", type: "medical_form_request", service_provider_name: "רופאה לדוגמה", request_status: "טופל", status_update_date: "2025-04-01T12:30:00", request_subjects: ["בקשה לדוגמה"] },
      { request_id: "102", type: "medical_form_request", service_provider_name: "רופא לדוגמה", request_status: "חדש", status_update_date: "2025-04-02T10:15:00" },
    ];
    const detail = { request_id: 101, patient_remark: "טקסט המטופל המקורי 123456789", doctor_remark: "תשובת הרופאה במקור", creation_date: "2025-03-31T23:59:59", update_date: "2025-04-01T12:30:00", medical_forms_details: [{ document_id: "synthetic-document", document_description: "תיאור המקור", hash: "synthetic-private-signature" }] };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listInquiries: async () => result(rows), getInquiry: async ref => { requested = ref; return result(detail); } }), exportSession: async () => saved }) });
    const list = structured(await h.client.callTool({ name: "maccabi_doctor_inquiries", arguments: { limit: 1 } }));
    expect(withoutRefs(list.data)).toEqual([rows[0]]);
    expect(list.page).toMatchObject({ returned: 1, nextOffset: 1, truncated: true, completeHistory: false });
    const response = await h.client.callTool({ name: "maccabi_detail", arguments: { ref: list.data[0].ref } });
    expect(requested).toBe("101");
    expect(structured(response).data.patient_remark).toBe(detail.patient_remark);
    expect(structured(response).data.doctor_remark).toBe(detail.doctor_remark);
    expect(structured(response).data.creation_date).toBe(detail.creation_date);
    expect(structured(response).data.medical_forms_details).toEqual([{ document_id: "synthetic-document", document_description: "תיאור המקור" }]);
    expect(JSON.stringify(response)).not.toContain("synthetic-private-signature");
    expect(structured(response).source).toEqual(result(detail).source);
    expect(h.effects.saves).toBe(2);
  });
  test("inquiry unknown references and unsupported branches stay typed and do not remove a valid session", async () => {
    const saved = await session();
    for (const code of ["OWNER_MISMATCH", "UNSUPPORTED_FLOW"] as const) {
      const h = await setup({ connect: async () => ({ readers: fakeReaders({ getInquiry: async () => { throw new ReadOperationError(code, "inquiry"); } }), exportSession: async () => saved }) });
      const response = await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("inquiry", { request_id: "unknown-synthetic-reference" }) } });
      expect(response.isError).toBe(true); expect(structured(response).error.code).toBe(code);
      expect(h.effects.invalidates).toBe(0); expect(h.effects.saves).toBe(0);
    }
    const h = await setup();
    expect((await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("inquiry", { request_id: "101" }), member_id: "never-select-another-owner" } })).isError).toBe(true);
    expect((await h.client.callTool({ name: "maccabi_report", arguments: { document: "vaccination_certificate", path: "/private/never-read" } })).isError).toBe(true);
    expect(h.effects.loads).toBe(0);
  });
  test("vaccination PDF preserves original private bytes and provenance and enforces the document bound", async () => {
    const saved = await session();
    const bytes = new TextEncoder().encode("%PDF-1.4\nsynthetic certificate with printed identity 123456789");
    for (const oversized of [false, true]) {
      const original = result(oversized ? new Uint8Array(2 * 1024 * 1024 + 1) : bytes);
      const h = await setup({ connect: async () => ({ readers: fakeReaders({ getVaccinationCertificatePdf: async () => original }), exportSession: async () => saved }) });
      const response = await h.client.callTool({ name: "maccabi_report", arguments: { document: "vaccination_certificate" } });
      if (oversized) { expect(structured(response).error.code).toBe("RESULT_TOO_LARGE"); continue; }
      const resource = (response as any).content.find((item: any) => item.type === "resource").resource;
      expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
      expect(resource.mimeType).toBe("application/pdf");
      expect(resource.uri).toMatch(/^maccabi:\/\/document\/[0-9a-f-]+$/);
      expect(structured(response).source).toEqual(original.source);
      expect(structured(response).retrievedAt).toBe(original.retrievedAt);
      expect(structured(response).bytes).toBe(bytes.byteLength);
      expect(JSON.stringify(response)).not.toContain("https:");
    }
  });
});

describe("frontend-projected timelines and English summary", () => {
  test("fixed projected sensitivity/admin rows retain nulls, dates, source evidence and local bounds", async () => {
    const saved = await session();
    const sensitivities = [{ registration_date: "2025-06-01T00:00:00", sensitivity: "רגישות לדוגמה", practitioner_name: "שם מקור", speciality: null, sensitivity_presentation: "טקסט קליני מקורי", classification: 2 }];
    const administrative = [{ interaction_id: "synthetic-1", classification: "synthetic-classification", subject: "נושא בקשה", status: "טקסט מקור", status_update_date: "2025-07-08T13:14:15", has_content: false, drug_names_for_approval: null }, { interaction_id: "synthetic-2", classification: "synthetic-classification", subject: "נושא שני", is_read: null }];
    const source = { ...result([]).source, schemaEvidence: "frontend-field-projection" as const };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listSensitivities: async () => ({ ...result(sensitivities), source }), listAdministrativeRequests: async () => ({ ...result(administrative), source }) }), exportSession: async () => saved }) });
    const sensitive = structured(await h.client.callTool({ name: "maccabi_allergies", arguments: {} }));
    expect(withoutRefs(sensitive.data)).toEqual(sensitivities); expect(sensitive.source).toEqual(source);
    const admin = structured(await h.client.callTool({ name: "maccabi_administrative_requests", arguments: { limit: 1 } }));
    expect(withoutRefs(admin.data)).toEqual([administrative[0]]); expect(admin.source).toEqual(source);
    expect(admin.data[0].ref).toBe(ref("administrative_request", { interaction_id: "synthetic-1" }));
    expect(admin.page).toMatchObject({ nextOffset: 1, truncated: true, completeHistory: false });
    expect(h.effects.saves).toBe(2);
  });
  test("English PDF preserves original bytes and source metadata with no identity/setup arguments", async () => {
    const saved = await session();
    const bytes = new TextEncoder().encode("%PDF-1.4\nsynthetic English report ORIGINAL 123456789");
    const original = result(bytes);
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getEnglishMedicalSummaryPdf: async () => original }), exportSession: async () => saved }) });
    const response = await h.client.callTool({ name: "maccabi_report", arguments: { document: "english_medical_summary" } });
    const resource = (response as any).content.find((item: any) => item.type === "resource").resource;
    expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
    expect(structured(response).source).toEqual(original.source);
    expect(structured(response).retrievedAt).toBe(original.retrievedAt);
    expect(structured(response).containsOriginalDocument).toBe(true);
    expect(JSON.stringify(response)).not.toContain("https:");
    expect((await h.client.callTool({ name: "maccabi_report", arguments: { document: "english_medical_summary", passport: "never-submitted" } })).isError).toBe(true);
    expect(h.effects.loads).toBe(1);
  });
  test("new PDF and projected timeline keep the common bounds and safe unsupported error", async () => {
    const saved = await session();
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getEnglishMedicalSummaryPdf: async () => result(new Uint8Array(2 * 1024 * 1024 + 1)), listAdministrativeRequests: async () => { throw new ReadOperationError("UNSUPPORTED_FLOW", "administrative-requests"); } }), exportSession: async () => saved }) });
    expect(structured(await h.client.callTool({ name: "maccabi_report", arguments: { document: "english_medical_summary" } })).error.code).toBe("RESULT_TOO_LARGE");
    expect(structured(await h.client.callTool({ name: "maccabi_administrative_requests", arguments: {} })).error.code).toBe("UNSUPPORTED_FLOW");
    expect(h.effects.invalidates).toBe(0);
    const loads = h.effects.loads;
    expect((await h.client.callTool({ name: "maccabi_administrative_requests", arguments: { limit: 51 } })).isError).toBe(true);
    expect(h.effects.loads).toBe(loads);
  });
});


describe("legacy medical views", () => {
  test("recommendations and selected summary preserve original clinical text and tables", async () => {
    const saved = await session();
    const table = { columns: ["כותרת", "ערך"], rows: [["טקסט קליני 123456789", "4.25 mmol/L"]] };
    const recommendations = result({ introduction: "פתיחה", sections: [{ title: "מקור", table }], closingNote: "הערה" });
    const summary = result({ description: "תיאור", medications: { title: "תרופות", context: "מקור", table }, laboratory: { title: "מעבדה", context: "מקור", table } });
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getMedicalRecommendations: async () => recommendations, getSelectedMedicalSummary: async () => summary }), exportSession: async () => saved }) });
    expect(structured(await h.client.callTool({ name: "maccabi_medical_recommendations", arguments: {} }))).toEqual(recommendations);
    expect(structured(await h.client.callTool({ name: "maccabi_medical_summary", arguments: {} }))).toEqual(summary);
    expect(h.effects.saves).toBe(2);
  });

  test("hospital history retains complete selected rows and forwards explicit as-of date", async () => {
    const saved = await session();
    const rows = ["א", "ב"].map(NameHospital => ({ NameHospital, DateHospitalization: "2026-01-02", Date: "מקור", DurationHospitalization: "1", QuantityTreatments: "1", TypeCommitment: "מקור", Department: "דוגמה", HasLink: false, DescriptionTreatment: [{ Description: "טקסט קליני" }], DescriptionDistinction: [] }));
    const original = result(rows);
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listHospitalHistory: async asOf => { expect(asOf).toBe("2026-09-20"); return original; } }), exportSession: async () => saved }) });
    const response = structured(await h.client.callTool({ name: "maccabi_hospital_visits", arguments: { as_of: "2026-09-20", limit: 1, offset: 1 } }));
    expect(withoutRefs(response.data)).toEqual([rows[1]]);
    expect(response.source).toEqual(original.source);
    expect(response.page.completeHistory).toBe(false);
  });

  test("legacy strict schemas reject caller-selected identity and invalid dates before session access", async () => {
    const h = await setup();
    for (const name of ["maccabi_medical_recommendations", "maccabi_medical_summary"]) {
      expect((await h.client.callTool({ name, arguments: { sr_id: "never-used" } })).isError).toBe(true);
    }
    for (const args of [{}, { as_of: "2026-02-30" }, { as_of: "2026-09-20", owner: "never-selected" }]) {
      expect((await h.client.callTool({ name: "maccabi_hospital_visits", arguments: args })).isError).toBe(true);
    }
    expect(h.effects.loads).toBe(0);
  });
});


describe("owner contact and notifications", () => {
  test("settings reads retain false states, source restrictions and intentionally displayed viewer IDs", async () => {
    const saved = await session();
    const state = { code: 1, name: "מקור", description: null, registered: false, canRegister: false, restrictionDescription: "הגבלה מקורית", restrictionCode: 2, order: 1 };
    const preferences = result({ statusCode: 0, preferredLanguageCode: 1, contact: { cellPhone: "0000000000", email: "example@example.invalid" }, groups: [{ ...state, services: [{ ...state, typeCode: null, defaultChannelCode: 1, selectedChannelCode: 2, isMaccabitonType: false, channels: [state] }] }] });
    const access = result({ state: "viewer-list" as const, users: [{ first_name: "שם", last_name: "סינתטי", user_id: "000000000", authentication_end_date: "2026-12-31" }] });
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getNotificationPreferences: async () => preferences, listAccountAccess: async () => access }), exportSession: async () => saved }) });
    expect(structured(await h.client.callTool({ name: "maccabi_account", arguments: { section: "notification_settings" } }))).toEqual(preferences);
    expect(structured(await h.client.callTool({ name: "maccabi_account", arguments: { section: "authorized_users" } }))).toEqual(access);
    expect(h.effects.saves).toBe(2);
    const creation = result({ state: "creation-available" as const, users: [] });
    const empty = await setup({ connect: async () => ({ readers: fakeReaders({ listAccountAccess: async () => creation }), exportSession: async () => saved }) });
    expect(structured(await empty.client.callTool({ name: "maccabi_account", arguments: { section: "authorized_users" } }))).toEqual(creation);
    const invalid = await setup();
    for (const section of ["notification_settings", "authorized_users"]) {
      for (const args of [{ owner: "never-selected" }, { registered: true }, { user_id: "never-selected" }, { limit: 1 }]) expect((await invalid.client.callTool({ name: "maccabi_account", arguments: { section, ...args } })).isError).toBe(true);
    }
    expect(invalid.effects.loads).toBe(0);
  });

  test("contact profile intentionally preserves requested contact fields without identity inputs", async () => {
    const saved = await session();
    const original = result({ email: "example@example.invalid", phones_update_date: "2026-01-02", phones: [{ phone_type: "home", phone_prefix: "00", phone_no: 1234, fax_special_prefix: "" }], addresses: [{ city_name: "עיר סינתטית", street_name: "רחוב סינתטי", house_num: "1", apartment_num: "2" }] });
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getOwnerContactProfile: () => original }), exportSession: async () => saved }) });
    expect(structured(await h.client.callTool({ name: "maccabi_account", arguments: { section: "contact_details" } }))).toEqual(original);
    expect(h.effects.saves).toBe(1);
    const invalid = await setup();
    expect((await invalid.client.callTool({ name: "maccabi_account", arguments: { section: "contact_details", member_id: "never-selected" } })).isError).toBe(true);
    expect(invalid.effects.loads).toBe(0);
  });

  test("notifications preserve source labels and dates with explicit range and local bounds", async () => {
    const saved = await session();
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const rows = ["א", "ב"].map(letter_desc => ({ letter_type: 1, letter_desc, item_date: "2026-01-02", original_item_date: "2026-01-01" }));
    const original = result(rows);
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listNotifications: async selectedRange => { expect(selectedRange).toEqual(range); return original; } }), exportSession: async () => saved }) });
    const response = structured(await h.client.callTool({ name: "maccabi_mailings", arguments: { ...range, limit: 1, offset: 1 } }));
    expect(withoutRefs(response.data)).toEqual([rows[1]]);
    expect(response.source).toEqual(original.source);
    expect(response.page.completeHistory).toBe(false);
  });
});


describe("vaccination dose and mailing projections", () => {
  test("mailing statuses and tutorial references preserve frontend evidence and visible links", async () => {
    const saved = await session();
    const rows = [
      { letter_type: 2, status: 1, item_date: "2026-01-02", original_item_date: "2026-01-01", has_document: true, reference: "b".repeat(64) },
      { letter_type: 3, service_type_text: "מקור", practitioner_name: "שם סינתטי", item_date: "2026-01-02", original_item_date: "2026-01-01", tutorials: [{ tutorial_type: "pdf", display_text: "מסמך מקורי", pdf_reference: "a".repeat(64) }, { tutorial_type: "video", display_text: "הוראה", link: "https://example.invalid/instructions" }] },
    ];
    const original = { ...result(rows), source: { ...result(rows).source, schemaEvidence: "frontend-field-projection" as const } };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listNotifications: async () => original }), exportSession: async () => saved }) });
    const response = structured(await h.client.callTool({ name: "maccabi_mailings", arguments: { from: "2026-01-01", to: "2026-12-31" } }));
    expect(withoutRefs(response.data)).toEqual(rows);
    expect(response.source).toEqual(original.source);
    expect(response.data[0].reference).toBe("b".repeat(64));
    // A type-2 row's own reference travels inside its token; a type-3 row's documents are its tutorials.
    expect(response.data[0].ref).toBe(ref("mailing", { from: "2026-01-01", to: "2026-12-31", reference: "b".repeat(64) }));
    expect(response.data[1].ref).toBe(ref("mailing", { from: "2026-01-01", to: "2026-12-31" }));
  });

  test("vaccination doses require an integer group reference and preserve bounded original data", async () => {
    const saved = await session();
    const rows = [{ vaccination_date: "2026-01-02", vaccination_place: null, remark: "טקסט מקור 123456789" }, { vaccination_date: "2026-02-02" }];
    const original = { ...result(rows), source: { ...result(rows).source, schemaEvidence: "frontend-field-projection" as const } };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getVaccinationDoses: async code => { expect(code).toBe(7); return original; } }), exportSession: async () => saved }) });
    const response = structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("vaccination_group", { vaccine_group_code: 7 }), limit: 1 } }));
    expect(withoutRefs(response.data)).toEqual([rows[0]]);
    expect(response.source).toEqual(original.source);
    expect(response.page.completeHistory).toBe(false);
    const invalid = await setup();
    for (const args of [{}, { ref: ref("vaccination_group", { vaccine_group_code: -1 } as never) }, { ref: ref("vaccination_group", { vaccine_group_code: 1.5 } as never) }, { ref: ref("vaccination_group", { vaccine_group_code: 7 }), birth_date: "2000-01-01" }]) {
      expect((await invalid.client.callTool({ name: "maccabi_detail", arguments: args })).isError).toBe(true);
    }
    expect(invalid.effects.loads).toBe(0);
  });
});


describe("owner-listed hospital PDF", () => {
  test("hospital optional range reaches list and PDF unchanged and rejects invalid pairs before lease", async () => {
    const saved = await session();
    const selected = { from: "2026-01-01", to: "2026-09-01" };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listHospitalHistory: async (asOf, range) => { expect(asOf).toBe("2026-09-20"); expect(range).toEqual(selected); return result([]); }, getHospitalReportPdf: async (reference, asOf, range) => { expect(reference).toBe("a".repeat(64)); expect(asOf).toBe("2026-09-20"); expect(range).toEqual(selected); return result(new TextEncoder().encode("%PDF-synthetic")); } }), exportSession: async () => saved }) });
    expect((await h.client.callTool({ name: "maccabi_hospital_visits", arguments: { as_of: "2026-09-20", ...selected } })).isError).not.toBe(true);
    expect((await h.client.callTool({ name: "maccabi_document", arguments: { ref: ref("hospital_report", { reference: "a".repeat(64), as_of: "2026-09-20", ...selected }) } })).isError).not.toBe(true);
    const invalid = await setup();
    // The same three bad ranges are rejected whether they arrive as list arguments or inside a ref.
    for (const dates of [{ from: selected.from }, { from: selected.to, to: selected.from }, { from: selected.from, to: "2026-10-01" }]) {
      expect((await invalid.client.callTool({ name: "maccabi_hospital_visits", arguments: { as_of: "2026-09-20", ...dates } })).isError).toBe(true);
      expect((await invalid.client.callTool({ name: "maccabi_document", arguments: { ref: ref("hospital_report", { reference: "a".repeat(64), as_of: "2026-09-20", ...dates } as never) } })).isError).toBe(true);
    }
    expect(invalid.effects.loads).toBe(0);
  });

  test("hospital PDF preserves original bytes/provenance and enforces the shared size bound", async () => {
    const saved = await session();
    const bytes = new TextEncoder().encode("%PDF-1.4 synthetic hospital report");
    const original = result(bytes);
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getHospitalReportPdf: async (reference, asOf) => { expect(reference).toBe("a".repeat(64)); expect(asOf).toBe("2026-09-20"); return original; } }), exportSession: async () => saved }) });
    const args = { ref: ref("hospital_report", { reference: "a".repeat(64), as_of: "2026-09-20" }) };
    const response = await h.client.callTool({ name: "maccabi_document", arguments: args });
    const resource = (response as any).content.find((item: any) => item.type === "resource").resource;
    expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
    expect(structured(response).source).toEqual(original.source);
    const bounded = await setup({ connect: async () => ({ readers: fakeReaders({ getHospitalReportPdf: async () => result(new Uint8Array(2 * 1024 * 1024 + 1)) }), exportSession: async () => saved }) });
    expect(structured(await bounded.client.callTool({ name: "maccabi_document", arguments: args })).error.code).toBe("RESULT_TOO_LARGE");
  });

  test("hospital PDF rejects invalid dates and private path/type inputs before session", async () => {
    const h = await setup();
    for (const args of [{}, { ref: ref("hospital_report", { reference: "a".repeat(64), as_of: "2026-02-30" } as never) }, { ref: ref("hospital_report", { reference: "malformed", as_of: "2026-09-20" } as never) }, { ref: ref("hospital_report", { reference: "a".repeat(64), as_of: "2026-09-20" }), path: "/never-used", type: "never-used" }]) {
      expect((await h.client.callTool({ name: "maccabi_document", arguments: args })).isError).toBe(true);
    }
    expect(h.effects.loads).toBe(0);
  });
});


describe("source-backed PDF operations", () => {
  const reference = "a".repeat(64);
  const range = { from: "2026-01-01", to: "2026-12-31" };
  const testRef = encodeRef("test", { request_id: "synthetic-request", doc_id: "synthetic-doc" });
  /**
   * One row per document this server can fetch, as the call a caller actually makes. The arguments
   * the reader receives are asserted exactly, so the resolver's dispatch table cannot quietly send a
   * ref to the wrong reader or drop a value the ref was carrying.
   */
  const cases = [
    { name: "maccabi_report", method: "getLatestLabResultsPdf", args: { document: "latest_labs" }, expected: [] },
    { name: "maccabi_report", method: "getLatestLabResultsPdf", args: { document: "latest_labs", irregular_only: true }, expected: [{ irregularOnly: true }] },
    { name: "maccabi_report", method: "getLatestLabResultsPdf", args: { document: "latest_labs", irregular_only: false }, expected: [{ irregularOnly: false }] },
    { name: "maccabi_report", method: "getFollowedLabResultsPdf", args: { document: "followed_labs" }, expected: [] },
    { name: "maccabi_report", method: "getSensitivityPdf", args: { document: "allergies" }, expected: [] },
    { name: "maccabi_report", method: "getVaccinationCertificatePdf", args: { document: "vaccination_certificate" }, expected: [] },
    { name: "maccabi_report", method: "getEnglishMedicalSummaryPdf", args: { document: "english_medical_summary" }, expected: [] },
    { name: "maccabi_report", method: "getMedicationReportPdf", args: { document: "purchased_medications" }, expected: [] },
    { name: "maccabi_document", method: "getNursingInsuranceReportPdf", args: { ref: encodeRef("nursing_insurance_report", { reference }) }, expected: [reference] },
    { name: "maccabi_document", method: "getAdministrativeRequestPdf", args: { ref: encodeRef("administrative_request", { interaction_id: "synthetic" }), reference }, expected: ["synthetic", reference] },
    { name: "maccabi_document", method: "getImagingResultPdf", args: { ref: testRef }, expected: ["synthetic-request", "synthetic-doc"] },
    { name: "maccabi_document", method: "getLabReportPdf", args: { ref: testRef, variant: "laboratory_report" }, expected: ["synthetic-request", "synthetic-doc"] },
    { name: "maccabi_document", method: "getLabReportPdf", args: { ref: testRef, variant: "laboratory_report", irregular_only: true }, expected: ["synthetic-request", "synthetic-doc", { irregularOnly: true }] },
    { name: "maccabi_document", method: "getEnglishCovidLabReportPdf", args: { ref: testRef, variant: "english_covid_report" }, expected: ["synthetic-request", "synthetic-doc"] },
    { name: "maccabi_document", method: "getLabComparisonPdf", args: { ref: testRef, test_id: "synthetic-test", variant: "comparison_list" }, expected: [{ source: "result", requestId: "synthetic-request", docId: "synthetic-doc", testId: "synthetic-test" }, "list"] },
    { name: "maccabi_document", method: "getLabComparisonPdf", args: { ref: encodeRef("latest_labs", {}), test_id: "synthetic-test", variant: "comparison_graph" }, expected: [{ source: "latest", testId: "synthetic-test" }, "graph"] },
    { name: "maccabi_document", method: "getLabResultFilePdf", args: { ref: testRef, test_id: "synthetic-test" }, expected: [{ source: "result", requestId: "synthetic-request", docId: "synthetic-doc", testId: "synthetic-test" }] },
    { name: "maccabi_document", method: "getQuarterlyBillingReportPdf", args: { ref: encodeRef("billing_report", { reference, period: "1001" }) }, expected: [reference, "1001"] },
    { name: "maccabi_document", method: "getVisitSummaryPdf", args: { ref: encodeRef("visit", { appointment_id: "synthetic-visit" }) }, expected: ["synthetic-visit"] },
    { name: "maccabi_document", method: "getVisitDocumentPdf", args: { ref: encodeRef("visit", { appointment_id: "synthetic-visit" }), reference }, expected: ["synthetic-visit", reference] },
    { name: "maccabi_document", method: "getInquiryDocumentPdf", args: { ref: encodeRef("inquiry", { request_id: "synthetic-inquiry" }), reference }, expected: ["synthetic-inquiry", reference] },
    { name: "maccabi_document", method: "getPrescriptionPdf", args: { ref: encodeRef("prescription", { doc_id: "synthetic-doc" }) }, expected: ["synthetic-doc"] },
    { name: "maccabi_document", method: "getReferralPdf", args: { ref: encodeRef("referral", { referral_id: "synthetic-referral" }) }, expected: ["synthetic-referral"] },
    { name: "maccabi_document", method: "getNotificationPdf", args: { ref: encodeRef("mailing", { reference, ...range }) }, expected: [reference, range] },
    { name: "maccabi_document", method: "getNotificationPdf", args: { ref: encodeRef("mailing", { ...range }), reference }, expected: [reference, range] },
    { name: "maccabi_document", method: "getCertificatePdf", args: { ref: encodeRef("certificate", { reference, ...range }) }, expected: [reference, range] },
    { name: "maccabi_document", method: "getAdditionalInformationPdf", args: { ref: encodeRef("additional_information", { reference, ...range }) }, expected: [reference, range] },
    { name: "maccabi_document", method: "getHospitalReportPdf", args: { ref: encodeRef("hospital_report", { reference, as_of: "2026-12-31" }) }, expected: [reference, "2026-12-31", undefined] },
    { name: "maccabi_document", method: "getHospitalReportPdf", args: { ref: encodeRef("hospital_report", { reference, as_of: "2026-12-31", ...range }) }, expected: [reference, "2026-12-31", range] },
  ];
  test("lab attachment discovery retains safe availability and test ID without the private path", async () => {
    const saved = await session();
    const row = { test_id: "synthetic-test", test_desc: "תוצאה סינתטית", result: "טקסט מקור", result_file: "/private/synthetic-file", has_result_file: true };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getLabResult: async () => result({ results: [{ group_name: "מקור", group_values: [row] }], execute_date: "2026-01-02", is_partial: false }) }), exportSession: async () => saved }) });
    const response = structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: testRef } }));
    expect(response.data.results[0].group_values[0]).toEqual({ test_id: row.test_id, test_desc: row.test_desc, result: row.result, has_result_file: true });
    // The detail hands back the analyte's own next step, with the test_id already in place.
    expect(response.next).toEqual(expect.arrayContaining([{ tool: "maccabi_detail", arguments: { ref: testRef, test_id: "synthetic-test" }, why: expect.any(String) }]));
    expect(JSON.stringify(response)).not.toContain("/private/");
  });
  test("source-backed PDFs forward exact references and preserve original bytes/provenance within bounds", async () => {
    const saved = await session();
    for (const item of cases) {
      const bytes = new TextEncoder().encode("%PDF-1.4 synthetic original source-backed report");
      const original = { ...result(bytes), source: { ...result(bytes).source, schemaEvidence: "frontend-field-projection" as const } };
      const h = await setup({ connect: async () => ({ readers: fakeReaders({ [item.method]: async (...args: unknown[]) => { expect(args).toEqual(item.expected); return original; } }), exportSession: async () => saved }) });
      const response = await h.client.callTool({ name: item.name, arguments: item.args });
      const resource = (response as any).content.find((value: any) => value.type === "resource").resource;
      expect(Buffer.from(resource.blob, "base64")).toEqual(Buffer.from(bytes));
      expect(structured(response).source).toEqual(original.source);
      expect(h.effects.saves).toBe(1);
      const bounded = await setup({ connect: async () => ({ readers: fakeReaders({ [item.method]: async () => result(new Uint8Array(2 * 1024 * 1024 + 1)) }), exportSession: async () => saved }) });
      expect(structured(await bounded.client.callTool({ name: item.name, arguments: item.args })).error.code).toBe("RESULT_TOO_LARGE");
    }
  });
  test("visit and inquiry attachment discovery retains safe flags/references while private paths stay hidden", async () => {
    const saved = await session();
    const visit = { has_summary_pdf: true, visit_summary_pdf_link: "/private/synthetic-visit", clinical_text: "טקסט קליני מקורי", drugs: [{ pdf_reference: reference, pdf_link: "/private/synthetic-drug", drug_name: "תרופה סינתטית" }] };
    const inquiry = { medical_forms_details: [{ form_type: 1, pdf_reference: reference, link_pdf: "/private/synthetic-inquiry", clinical_text: "טקסט קליני מקורי" }] };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ getVisit: async () => result(visit), getInquiry: async () => result(inquiry) }), exportSession: async () => saved }) });
    const visitRef = encodeRef("visit", { appointment_id: "synthetic-visit" });
    const visitResponse = structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: visitRef } }));
    expect(visitResponse.data).toEqual({ has_summary_pdf: true, clinical_text: visit.clinical_text, drugs: [{ pdf_reference: reference, drug_name: "תרופה סינתטית" }] });
    expect(visitResponse.next).toEqual([
      { tool: "maccabi_document", arguments: { ref: visitRef }, why: expect.any(String) },
      { tool: "maccabi_document", arguments: { ref: visitRef, reference }, why: expect.any(String) },
    ]);
    const inquiryResponse = structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: encodeRef("inquiry", { request_id: "synthetic-inquiry" }) } }));
    expect(inquiryResponse.data).toEqual({ medical_forms_details: [{ form_type: 1, pdf_reference: reference, clinical_text: inquiry.medical_forms_details[0]!.clinical_text }] });
    expect(JSON.stringify([visitResponse, inquiryResponse])).not.toContain("/private/");
    const invalid = await setup();
    for (const args of [{ ref: encodeRef("inquiry", { request_id: "synthetic-inquiry" }), reference: "malformed" }, { ref: encodeRef("inquiry", { request_id: "synthetic-inquiry" }), reference, form_type: 5 }, { ref: encodeRef("inquiry", { request_id: "synthetic-inquiry" }) }]) {
      expect((await invalid.client.callTool({ name: "maccabi_document", arguments: args })).isError).toBe(true);
    }
    expect(invalid.effects.loads).toBe(0);
    expect((await invalid.client.callTool({ name: "maccabi_document", arguments: { ref: encodeRef("visit", { appointment_id: "synthetic-visit" }), reference: "malformed" } })).isError).toBe(true);
    expect(invalid.effects.loads).toBe(0);
  });
  test("source-backed PDF schemas reject identity/path inputs and malformed local references before session", async () => {
    const h = await setup();
    for (const item of cases) {
      expect((await h.client.callTool({ name: item.name, arguments: { ...item.args, path: "/never-used", member_id: "never-selected" } })).isError).toBe(true);
      expect((await h.client.callTool({ name: item.name, arguments: {} })).isError).toBe(true);
    }
    // A billing ref that never carried a usable reference or period is refused as a damaged ref.
    for (const payload of [{ reference: "malformed", period: "1001" }, { reference, period: "display-label" }]) {
      expect((await h.client.callTool({ name: "maccabi_document", arguments: { ref: encodeRef("billing_report", payload as never) } })).isError).toBe(true);
    }
    expect((await h.client.callTool({ name: "maccabi_document", arguments: { ref: encodeRef("billing_report", { reference, period: "1001" }), report_type: "never-selected" } })).isError).toBe(true);
    for (const args of [{ ref: encodeRef("latest_labs", {}), test_id: "synthetic", variant: "invented" }, { ref: encodeRef("latest_labs", {}), test_id: "synthetic", request_id: "forbidden", doc_id: "forbidden", variant: "comparison_graph" }]) {
      expect((await h.client.callTool({ name: "maccabi_document", arguments: args })).isError).toBe(true);
    }
    for (const kind of ["mailing", "additional_information"] as const) {
      const payloads = kind === "mailing"
        ? [{ reference: "malformed", ...range }, { reference, from: "2026-02-30", to: range.to }, { reference, from: range.to, to: range.from }]
        : [{ reference: "malformed", ...range }, { reference, from: "2026-02-30", to: range.to }, { reference, from: range.to, to: range.from }];
      for (const payload of payloads) expect((await h.client.callTool({ name: "maccabi_document", arguments: { ref: encodeRef(kind, payload as never) } })).isError).toBe(true);
    }
    expect(h.effects.loads).toBe(0);
  });
});


describe("explicit one-shot session renewal", () => {
  test("renewal uses the shared primitive, persists once, and advertises session mutation", async () => {
    const saved = await session();
    const original = result({ renewed: true as const });
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ renewSession: async () => original }), exportSession: async () => saved }) });
    expect(structured(await h.client.callTool({ name: "maccabi_renew_session", arguments: {} }))).toEqual(original);
    expect(h.effects.saves).toBe(1);
    const tool = (await h.client.listTools()).tools.find(tool => tool.name === "maccabi_renew_session")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false, destructiveHint: false });
    expect(tool.description).toContain("no extension duration");
  });
  test("renewal rejects caller identity and invalidates on forced reauthentication without retry", async () => {
    const saved = await session(); let calls = 0;
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ renewSession: async () => { calls++; throw new ReauthenticationRequired(401); } }), exportSession: async () => saved }) });
    expect((await h.client.callTool({ name: "maccabi_renew_session", arguments: { member_id: "never-selected" } })).isError).toBe(true);
    expect(h.effects.loads).toBe(0);
    const response = structured(await h.client.callTool({ name: "maccabi_renew_session", arguments: {} }));
    expect(response.error.code).toBe("REAUTHENTICATION_REQUIRED");
    expect(calls).toBe(1);
    expect(h.effects.invalidates).toBe(1);
    expect(h.effects.saves).toBe(0);
  });
});


describe("quarterly billing report catalog", () => {
  test("billing catalog preserves all period options and initial-page metadata without inventing paging", async () => {
    const saved = await session();
    const periods = [{ value: "1001", label: "תקופה א" }, { value: "1002", label: "תקופה ב" }];
    const original = result({ availablePeriods: periods, selectedPeriod: periods[1]!, reports: [{ period: "תקופה ב", productionDate: "2026-01-02", viewLabel: "צפייה בדוח סינתטי", reference: "a".repeat(64) }], pagination: { returned: 1, reportedResultCount: 3, totalPages: 3, currentPage: 1 as const } });
    for (const period of [undefined, periods[1]!.value]) {
      const h = await setup({ connect: async () => ({ readers: fakeReaders({ listQuarterlyBillingReports: async requested => { expect(requested).toBe(period); return original; } }), exportSession: async () => saved }) });
      const catalog = structured(await h.client.callTool({ name: "maccabi_billing_reports", arguments: period ? { period } : {} }));
      // The report's token carries the selected period, which is not the label the row displays.
      expect(catalog.data.reports[0].ref).toBe(ref("billing_report", { reference: "a".repeat(64), period: "1002" }));
      expect({ ...withoutNext(catalog), data: { ...catalog.data, reports: withoutRefs(catalog.data.reports) } }).toEqual(original);
    }
    const invalid = await setup();
    for (const args of [{ period: "" }, { period: "12345" }, { period: "malformed" }, { owner: "never-selected" }, { period: "synthetic", page: 2 }, { limit: 1 }]) {
      expect((await invalid.client.callTool({ name: "maccabi_billing_reports", arguments: args })).isError).toBe(true);
    }
    expect(invalid.effects.loads).toBe(0);
  });
});

describe("anonymous public directory MCP", () => {
  test("public discovery/search/detail bypass owner lease and preserve category and selection context", async () => {
    const catalog = result([{ field: "synthetic-key", label: "תחום לדוגמה" }]);
    const cities = result([{ city: "synthetic-city", label: "עיר סינתטית" }]);
    const reference = "provider-" + "a".repeat(32);
    for (const category of ["doctors", "labs-and-therapists"] as const) {
      let creations = 0;
      const options = { city: "synthetic-city", name: "שם סינתטי", page: 2 };
      const search = result({ category, field: catalog.data[0]!, providers: [], selection: { category, field: "synthetic-key", options }, filters: { city: cities.data[0]!, name: options.name }, coverage: { page: 2, returned: 0, reportedTotalItems: 120, reportedTotalPages: 12, pagingSupported: true as const } });
      const detail = result({ reference, First_Name: "שם סינתטי", ContactDetails: [], Schedules: [] } as any);
      const h = await setup({ resolveSession: async () => { throw new Error("Must not resolve"); }, connect: async () => { throw new Error("Must not connect"); }, runExclusive: async () => { throw new Error("Must not lock owner"); }, createDirectory: () => { creations++; return {
        listProviderFields: async selected => { expect(selected).toBe(category); return catalog; },
        listProviderCities: async selected => { expect(selected).toBe(category); return cities; },
        searchProviders: async (...args) => { expect(args).toEqual([category, "synthetic-key", options]); return search; },
        getProviderDetails: async (...args) => { expect(args).toEqual([category, "synthetic-key", reference, options]); return detail; },
      }; } });
      expect(withoutNext(structured(await h.client.callTool({ name: "maccabi_directory_specialties", arguments: { category } })))).toEqual(catalog);
      expect(structured(await h.client.callTool({ name: "maccabi_directory_cities", arguments: { category } }))).toEqual(cities);
      expect(withoutNext(structured(await h.client.callTool({ name: "maccabi_directory_search", arguments: { category, field: "synthetic-key", ...options } })))).toEqual(search);
      // A provider ref carries the whole search context, so the detail read never has to be handed it again.
      const providerRef = ref("directory_provider", { category, field: "synthetic-key", reference, ...options });
      expect(structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: providerRef } }))).toEqual(detail);
      expect(creations).toBe(4); expect(h.effects.loads).toBe(0); expect(h.effects.saves).toBe(0); expect(h.effects.invalidates).toBe(0);
    }
  });
  test("public directory schemas reject incomplete or private selectors and errors stay outside account state", async () => {
    let creations = 0;
    const fail = async (): Promise<never> => { throw new ReauthenticationRequired(401); };
    const h = await setup({ createDirectory: () => { creations++; return { listProviderFields: fail, listProviderCities: fail, searchProviders: fail, getProviderDetails: fail }; } });
    for (const args of [{}, { field: "a,b" }, { field: "two keys" }, { field: "a", owner: "forbidden" }, { field: "a", page: 0 }, { field: "a", page: 1001 }, { field: "a", city: "two cities" }, { field: "a", name: " " }, { field: "a", name: "x".repeat(201) }, { field: "a", name: "invalid\nname" }]) expect((await h.client.callTool({ name: "maccabi_directory_search", arguments: { category: "doctors", ...args } })).isError).toBe(true);
    for (const args of [{}, { category: "invented" }, { category: "doctors", owner: "forbidden" }]) expect((await h.client.callTool({ name: "maccabi_directory_specialties", arguments: args })).isError).toBe(true);
    const validProvider = ref("directory_provider", { category: "doctors", field: "a", reference: "provider-" + "a".repeat(32) });
    for (const args of [{ ref: ref("directory_provider", { category: "doctors", field: "a", reference: "malformed" } as never) }, { ref: validProvider, ItemKeyIndex: "forbidden" }]) expect((await h.client.callTool({ name: "maccabi_detail", arguments: args })).isError).toBe(true);
    expect(creations).toBe(0);
    for (const [name, args] of [["maccabi_directory_specialties", { category: "doctors" }], ["maccabi_directory_cities", { category: "doctors" }], ["maccabi_directory_search", { category: "doctors", field: "a" }], ["maccabi_detail", { ref: validProvider }]] as const) {
      expect((await h.client.callTool({ name, arguments: args })).isError).toBe(true);
    }
    expect(h.effects.loads).toBe(0); expect(h.effects.saves).toBe(0); expect(h.effects.invalidates).toBe(0);
    const huge = await setup({ createDirectory: () => ({ listProviderFields: async () => result([{ field: "a", label: "x".repeat(130 * 1024) }]), listProviderCities: fail, searchProviders: fail, getProviderDetails: fail }) });
    expect(structured(await huge.client.callTool({ name: "maccabi_directory_specialties", arguments: { category: "doctors" } })).error.code).toBe("RESULT_TOO_LARGE");
  });
});

/**
 * A model reading a public-directory failure has one dangerous move available to it: reporting the
 * empty result as fact. So the challenge carries its own code and says in the same breath that
 * nothing was searched, and the generic branch says it is not the challenge and not empty either.
 */
test("a bot challenge cannot be read as an empty directory result, and does not touch owner leases", async () => {
  const challenge = new MaccabiDirectory({ fetch: async () => new Response("<html>Are you a robot?</html>", { headers: { "Content-Type": "text/html" } }) });
  const h = await setup({ createDirectory: () => challenge });
  const response = await h.client.callTool({ name: "maccabi_directory_search", arguments: { category: "doctors", field: "synthetic-key" } });
  expect(response.isError).toBe(true); const error = structured(response).error;
  expect(error.code).toBe("DIRECTORY_BOT_CHALLENGE");
  for (const phrase of ["bot-challenge page", "No search reached the directory", "not an empty result", "may succeed on a retry"]) {
    expect(error.instruction).toContain(phrase);
  }
  const fail = async (): Promise<never> => { throw new UpstreamError("DIRECTORY_UNKNOWN_FIELD"); };
  const other = await setup({ createDirectory: () => ({ listProviderFields: fail, listProviderCities: fail, searchProviders: fail, getProviderDetails: fail }) });
  const rejected = structured(await other.client.callTool({ name: "maccabi_directory_search", arguments: { category: "doctors", field: "synthetic-key" } })).error;
  expect(rejected.code).toBe("DIRECTORY_UNKNOWN_FIELD");
  expect(rejected.instruction).toContain("not an empty result");
  for (const owner of [h, other]) { expect(owner.effects.loads).toBe(0); expect(owner.effects.saves).toBe(0); expect(owner.effects.invalidates).toBe(0); }
});

describe("sign-in tools", () => {
  const handle = (overrides: Partial<LoginHandle> = {}): LoginHandle => ({
    start: async () => ({ status: "sms-sent", phone: "Phone ending 12", expiresInSeconds: 600 }),
    verify: async () => ({ status: "signed-in", persistence: "session-file" }),
    status: async () => ({ status: "signed-out" }),
    logout: async () => ({ status: "local-session-removed" }),
    ...overrides,
  });

  test("start sends one SMS, or lists the numbered options without sending anything", async () => {
    const calls: [string, number | undefined][] = [];
    const h = await setup({ login: handle({ start: async (id, phone) => { calls.push([id, phone]); return phone === undefined ? { status: "phone-required", phones: [{ option: 1, label: "Phone ending 12" }, { option: 3, label: "Phone ending 34" }], expiresInSeconds: 600 } : { status: "sms-sent", phone: "Phone ending 34", expiresInSeconds: 600 }; } }) });
    expect(structured(await h.client.callTool({ name: "maccabi_login_start", arguments: { id: "012345678" } }))).toEqual({ status: "phone-required", phones: [{ option: 1, label: "Phone ending 12" }, { option: 3, label: "Phone ending 34" }], expiresInSeconds: 600 });
    expect(structured(await h.client.callTool({ name: "maccabi_login_start", arguments: { id: "012345678", phone: 3 } }))).toEqual({ status: "sms-sent", phone: "Phone ending 34", expiresInSeconds: 600 });
    expect(calls).toEqual([["012345678", undefined], ["012345678", 3]]);
    expect(h.effects.loads).toBe(0);
  });

  test("verify completes the sign-in and a rejected code is reported without echoing it", async () => {
    const h = await setup({ login: handle({ verify: async code => { expect(code).toBe("123456"); return { status: "signed-in", persistence: "session-file" }; } }) });
    expect(structured(await h.client.callTool({ name: "maccabi_login_verify", arguments: { code: "123456" } }))).toEqual({ status: "signed-in", persistence: "session-file" });

    const rejected = await setup({ login: handle({ verify: async () => { throw new UpstreamError("OTP_REJECTED"); } }) });
    const response = await rejected.client.callTool({ name: "maccabi_login_verify", arguments: { code: "123456" } });
    expect(response.isError).toBe(true);
    expect(structured(response).error.code).toBe("OTP_REJECTED");
    expect(structured(response).error.instruction).toContain("nothing was retried");
    expect(JSON.stringify(response)).not.toContain("123456");
  });

  test("a self-authored login error keeps its own guidance, and storage failures leak nothing", async () => {
    const missing = await setup({ login: handle({ verify: async () => { throw new LoginError("NO_PENDING_LOGIN", "No login is waiting for a code here."); } }) });
    expect(structured(await missing.client.callTool({ name: "maccabi_login_verify", arguments: { code: "123456" } })).error).toMatchObject({ code: "NO_PENDING_LOGIN", instruction: "No login is waiting for a code here." });

    const broken = await setup({ login: handle({ status: async () => { throw new Error("/home/example/.config/maccabi-mcp/pending-login.json unreadable"); } }) });
    const response = await broken.client.callTool({ name: "maccabi_login_status", arguments: {} });
    expect(structured(response).error.code).toBe("LOGIN_UNAVAILABLE");
    expect(JSON.stringify(response)).not.toContain("/home/example");
  });

  test("a storage failure during sign-in is named as storage, not as a failed sign-in step", async () => {
    const h = await setup({ login: handle({ status: async () => { throw new SessionStoreError("/home/example/.config/maccabi-mcp/pending-login.json could not be read."); } }) });
    const response = await h.client.callTool({ name: "maccabi_login_status", arguments: {} });
    expect(structured(response).error.code).toBe("SESSION_STORE_UNAVAILABLE");
    expect(structured(response).error.instruction).toContain("maccabi config directory");
    expect(JSON.stringify(response)).not.toContain("/home/example");
  });

  test("status and logout read and clear local state only", async () => {
    const h = await setup({ login: handle({ status: async () => ({ status: "pending-login", smsSent: true, expiresInSeconds: 412 }) }) });
    expect(structured(await h.client.callTool({ name: "maccabi_login_status", arguments: {} }))).toEqual({ status: "pending-login", smsSent: true, expiresInSeconds: 412 });
    expect(structured(await h.client.callTool({ name: "maccabi_logout", arguments: {} }))).toEqual({ status: "local-session-removed" });
    expect(h.effects.loads).toBe(0); expect(h.effects.saves).toBe(0); expect(h.effects.invalidates).toBe(0);
  });

  test("status-only drops the two tools that would carry the member ID and the SMS code", async () => {
    const h = await setup({ loginTools: "status-only", login: handle() });
    const { tools } = await h.client.listTools();
    const names = tools.map(tool => tool.name);
    expect(tools).toHaveLength(36);
    expect(names).not.toContain("maccabi_login_start");
    expect(names).not.toContain("maccabi_login_verify");
    // Status and logout stay: the browser leg replaces the sign-in, not the local state a member can read or clear.
    expect(names).toContain("maccabi_login_status");
    expect(names).toContain("maccabi_logout");
    await expect(h.client.callTool({ name: "maccabi_login_start", arguments: { id: "012345678" } })).rejects.toThrow("not found");
    // The instructions have to describe the tools that are actually there, or the model is told to call two that do not exist.
    const instructions = h.client.getInstructions() ?? "";
    expect(instructions).not.toContain("maccabi_login_start");
    expect(instructions).toContain("happens in the member's own browser");
  });

  test("schemas reject malformed or extra arguments before the handle is reached", async () => {
    let reached = 0;
    const count = async () => { reached++; throw new Error("unreachable"); };
    const h = await setup({ login: handle({ start: count as never, verify: count as never, status: count as never, logout: count as never }) });
    for (const [name, args] of [
      ["maccabi_login_start", { id: "0123456789" }], ["maccabi_login_start", { id: "12a" }], ["maccabi_login_start", {}],
      ["maccabi_login_start", { id: "012345678", phone: 0 }], ["maccabi_login_start", { id: "012345678", phone: 1.5 }], ["maccabi_login_start", { id: "012345678", code: "123456" }],
      ["maccabi_login_verify", { code: "12345" }], ["maccabi_login_verify", { code: "abcdef" }], ["maccabi_login_verify", {}],
      ["maccabi_login_status", { id: "012345678" }], ["maccabi_logout", { all: true }],
    ] as const) {
      expect((await h.client.callTool({ name, arguments: args })).isError).toBe(true);
    }
    expect(reached).toBe(0);
  });
  test("read failures carry per-code guidance that names the operation that failed", async () => {
    const saved = await session();
    const instructions = new Map<string, string>();
    for (const [code, operation] of [["OWNER_MISMATCH", "inquiry"], ["UNSUPPORTED_FLOW", "recent-providers"]] as const) {
      const h = await setup({ connect: async () => ({ readers: fakeReaders({ getInquiry: async () => { throw new ReadOperationError(code, operation); } }), exportSession: async () => saved }) });
      const response = await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("inquiry", { request_id: "unknown-synthetic-reference" }) } });
      expect(response.isError).toBe(true);
      expect(structured(response).error.code).toBe(code);
      expect(structured(response).error.instruction).toContain(operation);
      expect(h.effects.invalidates).toBe(0);
      instructions.set(code, structured(response).error.instruction);
    }
    expect(instructions.get("OWNER_MISMATCH")).not.toBe(instructions.get("UNSUPPORTED_FLOW"));
    expect(instructions.get("OWNER_MISMATCH")).toContain("Re-run the originating list");
    expect(instructions.get("UNSUPPORTED_FLOW")).toContain("require an adult account");
  });
  test("an agent is told to hand the member the issue link, and only where the failure is this client's", async () => {
    const saved = await session();
    const h = await setup({ connect: async () => ({ readers: fakeReaders({
      listSensitivities: async () => { throw new ReadOperationError("UNSUPPORTED_FLOW", "sensitivities"); },
      getInquiry: async () => { throw new ReadOperationError("OWNER_MISMATCH", "inquiry"); },
      getVisit: async () => { throw new Error("secret unexpected response body"); },
    }), exportSession: async () => saved }) });
    // The reader here is a model, and it cannot open an issue, so the ask has to be "give the member the link".
    const instructions = h.client.getInstructions() ?? "";
    expect(instructions).toContain(ISSUES_URL);
    expect(instructions).toContain("give the member");
    const instruction = async (name: string, args: Record<string, unknown>) => structured(await h.client.callTool({ name, arguments: args })).error.instruction as string;
    expect(await instruction("maccabi_allergies", {})).toContain(ISSUES_URL);
    expect(await instruction("maccabi_detail", { ref: ref("visit", { appointment_id: "fixture" }) })).toContain(ISSUES_URL);
    // A stale reference is the caller's own mistake; a needed login is neither a defect nor a missing feature.
    expect(await instruction("maccabi_detail", { ref: ref("inquiry", { request_id: "unknown-synthetic-reference" }) })).not.toContain(ISSUES_URL);
    const signedOut = await setup({ resolveSession: async () => null });
    const reauth = structured(await signedOut.client.callTool({ name: "maccabi_allergies", arguments: {} })).error;
    expect(reauth.code).toBe("REAUTHENTICATION_REQUIRED");
    expect(reauth.instruction).not.toContain(ISSUES_URL);
  });
  test("test rows advertise has_document without exposing the attachment path", async () => {
    const saved = await session();
    const row = {
      request_id: "synthetic-request", doc_id: "synthetic-document", type: "imaging_result", has_document: true,
      test_name: ["בדיקה לדוגמה"], member_id: "123456789", member_id_code: 0, hash: "synthetic-signature",
      result_files: [{ result_file: "synthetic/attachment/path" }],
    };
    const h = await setup({ connect: async () => ({ readers: fakeReaders({ listTests: async () => result({ categories: [], tests: [row] as any }) }), exportSession: async () => saved }) });
    const response = structured(await h.client.callTool({ name: "maccabi_tests", arguments: {} }));
    expect(withoutRefs(response.data)).toEqual([{ request_id: row.request_id, doc_id: row.doc_id, type: row.type, has_document: true, test_name: row.test_name }]);
    expect(JSON.stringify(response)).not.toContain("synthetic/attachment/path");
    // has_document is what decides whether a document step is offered at all.
    expect(response.next).toEqual(expect.arrayContaining([{ tool: "maccabi_document", arguments: { ref: response.data[0].ref }, why: expect.any(String) }]));
    // A laboratory report exists only for a laboratory row, so a list without one offers none.
    expect(JSON.stringify(response.next)).not.toContain("laboratory_report");
    // The two kinds the source attaches no document to are laboratory results and imaging studies, so
    // the step has to skip the study and land on the laboratory row rather than on whatever came first.
    const study = { request_id: "synthetic-study", doc_id: "synthetic-study-document", type: "imaging_study", has_document: false, test_name: ["הדמיה"] };
    const laboratory = { request_id: "synthetic-lab", doc_id: "synthetic-lab-document", type: "lab_result", has_document: false, test_name: ["ספירת דם"] };
    const mixed = await setup({ connect: async () => ({ readers: fakeReaders({ listTests: async () => result({ categories: [], tests: [row, study, laboratory] as any }) }), exportSession: async () => saved }) });
    const rows = structured(await mixed.client.callTool({ name: "maccabi_tests", arguments: {} }));
    expect(rows.next).toEqual(expect.arrayContaining([{ tool: "maccabi_document", arguments: { ref: rows.data[2].ref, variant: "laboratory_report" }, why: expect.any(String) }]));
  });
});

describe("imaging viewer tools", () => {
  const STUDY = "1.2.826.0.1.3680043.8.498.10000000000001.1700000000.1000001";
  const SERIES = "1.2.826.0.1.3680043.8.498.20000000000002.1700000000.2001";
  const SOP = "1.2.826.0.1.3680043.8.498.30000000000003.1700000000.3001";
  async function imaging(overrides: Partial<ReaderOperations> = {}) {
    const saved = await session();
    const asked: unknown[][] = [];
    const readers = fakeReaders({
      listImagingStudies: async () => { asked.push(["list"]); return result([{ request_id: STUDY, doc_id: "synthetic-document", type: "imaging_study", member_id: "123456789", member_id_code: 0, hash: "synthetic-signature" }] as any); },
      getImagingStudy: async (study: string) => { asked.push(["study", study]); return result({ studyInstanceUID: study, studyDescription: "US SOFT TISSUE NECK", mainModality: "US", patientName: "TEST PATIENT", patientID: "0999999999", patientBirthDate: "1990-01-01", series: [{ seriesInstanceUID: SERIES, modality: "US", instances: [{ sopInstanceUID: SOP, numberOfFrames: 0 }] }] } as any); },
      getImagingImage: async (study: string, series: string, sop: string) => { asked.push(["image", study, series, sop]); return result({ studyInstanceUID: study, seriesInstanceUID: series, sopInstanceUID: sop, rows: 970, columns: 1552, bitsAllocated: 8, numberOfFrames: 1, accessionNumber: "ACC00000001", patientID: "0999999999", viewPortLabels: { left: ["ACC00000001", "TEST PATIENT"] }, attributes: { "00100010": "TEST PATIENT", "00080090": "DR X" } } as any); },
      ...overrides,
    });
    const h = await setup({ connect: async () => ({ readers, exportSession: async () => saved }) });
    return { ...h, asked };
  }

  test("the three tools chain study to series to image", async () => {
    const h = await imaging();
    const studies = structured(await h.client.callTool({ name: "maccabi_imaging_studies", arguments: {} }));
    expect(studies.data[0].request_id).toBe(STUDY);
    const studyRef = studies.data[0].ref;
    expect(studyRef).toBe(ref("imaging_study", { study_instance_uid: STUDY }));
    const study = structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: studyRef } }));
    expect(study.data.series[0].seriesInstanceUID).toBe(SERIES);
    // The study result hands over the exact call for one image, UIDs and all.
    expect(study.next).toEqual([{ tool: "maccabi_detail", arguments: { ref: studyRef, series_instance_uid: SERIES, sop_instance_uid: SOP }, why: expect.any(String) }]);
    await h.client.callTool({ name: "maccabi_detail", arguments: study.next[0].arguments });
    expect(h.asked).toEqual([["list"], ["study", STUDY], ["image", STUDY, SERIES, SOP]]);
  });

  test("viewer payloads reach model context with the patient stripped out of them", async () => {
    const h = await imaging();
    const studyRef = ref("imaging_study", { study_instance_uid: STUDY });
    const study = await h.client.callTool({ name: "maccabi_detail", arguments: { ref: studyRef } });
    expect(JSON.stringify(study)).not.toContain("TEST PATIENT");
    expect(JSON.stringify(study)).not.toContain("0999999999");
    expect(structured(study).data.studyDescription).toBe("US SOFT TISSUE NECK");
    const image = await h.client.callTool({ name: "maccabi_detail", arguments: { ref: studyRef, series_instance_uid: SERIES, sop_instance_uid: SOP } });
    // Accession number, rendered corner labels and the raw hex-keyed DICOM tag bag all go together.
    for (const leaked of ["ACC00000001", "TEST PATIENT", "DR X", "0999999999"]) expect(JSON.stringify(image)).not.toContain(leaked);
    expect(structured(image).data.rows).toBe(970);
  });

  test("anything that is not a DICOM UID is refused by the schema, before a session is resolved", async () => {
    const h = await imaging();
    // Inside a ref the UID is checked when the token is decoded; as a selector it is checked by the schema.
    for (const uid of ["not-a-uid", "1.2.3/../../etc", "1.".repeat(40)]) {
      expect((await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("imaging_study", { study_instance_uid: uid } as never) } })).isError).toBe(true);
      expect((await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("imaging_study", { study_instance_uid: STUDY }), series_instance_uid: uid, sop_instance_uid: SOP } })).isError).toBe(true);
    }
    // One half of an image selection is not a selection, and that is decided before any session too.
    expect(structured(await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("imaging_study", { study_instance_uid: STUDY }), series_instance_uid: SERIES } })).error.code).toBe("INVALID_SELECTION");
    expect((await h.client.callTool({ name: "maccabi_detail", arguments: { ref: ref("imaging_study", { study_instance_uid: STUDY }), extra: "no" } })).isError).toBe(true);
    expect(h.asked).toEqual([]);
    expect(h.effects.loads).toBe(0);
  });

  /** Deliberate: a 1.5 MB headerless buffer and a JPEG are useless in a transcript. The CLI writes them. */
  test("no tool hands image bytes back, and the coverage says where they live instead", async () => {
    const h = await imaging();
    const names = (await h.client.listTools()).tools.map(tool => tool.name);
    expect(names).not.toContain("maccabi_imaging_pixels");
    expect(names).not.toContain("maccabi_imaging_thumbnail");
    const coverage = JSON.stringify(await h.client.readResource({ uri: COVERAGE_URI }));
    expect(coverage).toContain("maccabi imaging-pixels");
    expect(coverage).toContain("run live against that viewer end to end");
    expect(coverage).toContain("no viewer error response was ever captured");
  });
});

/**
 * One session, one thing at a time - and never for ever. These cover the bound that stops a stalled
 * call from taking the whole server with it, and the tool names this server quotes in its own text.
 */
describe("a stalled call never becomes a server that stops answering", () => {
  test("a read that never settles is answered with a timeout and the next call still runs", async () => {
    // Live, two freshly started servers blocked on their first session tool call and never replied.
    // A client cannot cancel that, so an abandoned call plus an error beats an unbounded wait.
    let attempts = 0;
    const h = await setup({
      operationTimeoutMs: 120,
      connect: async () => {
        if (++attempts === 1) return new Promise(() => {}); // neither answers nor fails
        return { readers: fakeReaders({ getOwnerProfile: () => result(profile) as any }), exportSession: async () => session() as any };
      },
    });
    const stalled = await h.client.callTool({ name: "maccabi_account", arguments: { section: "profile" } });
    expect(stalled.isError).toBe(true);
    expect(structured(stalled).error.code).toBe("REQUEST_TIMEOUT");
    expect(JSON.stringify(stalled)).not.toContain("123456789");
    expect(h.effects.saves).toBe(0);
    // Nothing was wrong with the credential, so an abandoned call must never cost the member an SMS.
    expect(h.effects.invalidates).toBe(0);
    const after = await h.client.callTool({ name: "maccabi_account", arguments: { section: "profile" } });
    expect(after.isError).not.toBe(true);
    expect(structured(after).data.f_name_hebrew).toBe("דוגמה");
  });

  test("work that outlives its deadline does not write its stale session over the call that replaced it", async () => {
    const h = await setup({
      operationTimeoutMs: 60,
      connect: async () => {
        await new Promise(resolve => setTimeout(resolve, 200)); // lands long after the caller gave up
        return { readers: fakeReaders({ getOwnerProfile: () => result(profile) as any }), exportSession: async () => session() as any };
      },
    });
    expect(structured(await h.client.callTool({ name: "maccabi_account", arguments: { section: "profile" } })).error.code).toBe("REQUEST_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, 400));
    // The abandoned call finished in the background. Saving from there would drop its older cookie
    // jar over whatever ran after it, which can cost the member the SMS that replaces a rotated cookie.
    expect(h.effects.saves).toBe(0);
  });

  test("a read that merely waited its turn still saves the session it refreshed", async () => {
    // The bound runs per task from the moment it reaches the front of the queue, not from the moment
    // it was asked for. Timing it from the call would make a read that only queued behind a stalled
    // one look abandoned, and silently drop a save it was entitled to make.
    const exclusive = serialExecutor(120);
    const h = await setup({
      operationTimeoutMs: 120, runExclusive: exclusive,
      connect: async () => ({ readers: fakeReaders({ getOwnerProfile: () => result(profile) as any }), exportSession: async () => session() as any }),
    });
    // Two stalls ahead of it, so this read waits well past a single bound before its turn arrives.
    const stalled = [exclusive(() => new Promise(() => {})), exclusive(() => new Promise(() => {}))]
      .map(task => task.catch(() => undefined));
    const queued = await h.client.callTool({ name: "maccabi_account", arguments: { section: "profile" } });
    expect(queued.isError).not.toBe(true);
    expect(h.effects.saves).toBe(1);
    await Promise.all(stalled);
  });

  test("every tool this server names in its own text is a tool it actually registers", async () => {
    // maccabi_billing_report_pdf survived a rename inside the billing-reports coverage text and sent
    // any caller that followed maccabi_capabilities to a tool that does not exist; maccabi_directory_fields
    // did the same inside a directory error. Both only ever appear as prose, so nothing typed caught them.
    const h = await setup();
    const { tools } = await h.client.listTools();
    const registered = new Set(tools.map(tool => tool.name));
    const capabilities = structured(await h.client.callTool({ name: "maccabi_capabilities", arguments: {} }));
    const spoken = [
      JSON.stringify(tools),
      h.client.getInstructions() ?? "",
      JSON.stringify(capabilities),
      JSON.stringify(await h.client.readResource({ uri: COVERAGE_URI })),
      // Guidance that only appears on a failure path is never in a response a passing test reads,
      // so the files that hold the caller-facing prose are swept directly.
      ...["../src/tools.ts", "../src/stdio.ts", "../src/reference.ts"].map(file => readFileSync(new URL(file, import.meta.url), "utf8")),
    ].join(" ");
    const named = [...new Set(spoken.match(/maccabi_[a-z_]+/g) ?? [])];
    expect(named.length).toBeGreaterThan(30);
    expect(named.filter(name => !registered.has(name))).toEqual([]);
    // The one call an agent starts from must be the one that cannot point at nothing.
    expect(JSON.stringify(capabilities)).toContain("maccabi_document");
    expect(JSON.stringify(capabilities)).not.toContain("maccabi_billing_report_pdf");
  });
});
