import { describe, expect, test } from "vitest";
import { MaccabiReaders, ReadOperationError, READ_ERROR_GUIDANCE, type ReadErrorCode, type ReadTransport } from "../src/readers";
import { ISSUES_URL } from "../src/errors";
import { FIXTURE_MEMBER_ID, testRow, type SourceTestRow, type SourceTestRowType } from "./fixtures/test-rows";
const profile = { member_id: FIXTURE_MEMBER_ID, member_id_code: "0", f_name_hebrew: "דוגמה", l_name_hebrew: "בדיקה", f_name_english: "Example", l_name_english: "Fixture", birth_date: "2000-01-01", sex: "synthetic" };
const bootstrap = () => ({ logged_customer_info: { ...profile }, current_customer_info: { ...profile }, token: { content: "synthetic-api-token", success: true }, family_data: [{ private: "must not be returned" }] });
class MockTransport implements ReadTransport {
  calls: { path: string; init?: RequestInit & { apiAuthorization?: boolean } }[] = [];
  token = "";
  constructor(readonly responses: unknown[]) {}
  setApiToken(token: string) { this.token = token; }
  async request(input: string | URL, init?: RequestInit & { apiAuthorization?: boolean }) {
    this.calls.push({ path: String(input), init });
    const next = this.responses.shift();
    return next instanceof Response ? next : Response.json(next);
  }
}
describe("source-backed owner reads", () => {
  test("bootstrap isolates the logged owner and keeps token and family data private", async () => {
    const transport = new MockTransport([bootstrap()]);
    const readers = await MaccabiReaders.create(transport);
    expect(transport.calls[0]?.path).toBe("/sonline/TokenServerAPI/webapi/mac/v4/members/token/full?checksum=&sr_id=");
    expect(transport.token).toBe("synthetic-api-token");
    expect(readers.getOwnerProfile().data).toEqual(profile);
    expect(JSON.stringify(readers.getOwnerProfile())).not.toContain("private");
    expect(JSON.stringify(readers.getOwnerProfile())).not.toContain("token");
  });
  test("selected dependent and expected-owner mismatch fail before installing token, under separate codes", async () => {
    const data = bootstrap(); data.current_customer_info.member_id = 222222222;
    const transport = new MockTransport([data]);
    await expect(MaccabiReaders.create(transport)).rejects.toMatchObject({ code: "DEPENDENT_SELECTED", operation: "account" });
    expect(transport.token).toBe("");
    await expect(MaccabiReaders.create(new MockTransport([bootstrap()]), { memberId: 222222222, memberIdCode: "0" })).rejects.toMatchObject({ code: "OWNER_MISMATCH", operation: "account" });
  });
  test("an F5 logon page asks for reauthentication, while any other HTML stays a parsing gap", async () => {
    const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    await expect(MaccabiReaders.create(new MockTransport([html("<html><body>BIG-IP logon page served by F5 Networks</body></html>")]))).rejects.toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
    await expect(MaccabiReaders.create(new MockTransport([html("<html><body><a href=\"/my.policy\">continue</a></body></html>")]))).rejects.toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
    await expect(MaccabiReaders.create(new MockTransport([html("<html><body>upstream maintenance notice</body></html>")]))).rejects.toMatchObject({ code: "INVALID_RESPONSE", operation: "account" });
  });
  test("prescription output preserves exact Hebrew, source values and owner-only POST", async () => {
    const row = { doc_id: "fixture-document", drug_name: "תרופה לדוגמה", drug_instructions: "טקסט מקורי", from_date: "original-date-text", to_date: "original-date-text", member_id: String(profile.member_id), member_id_code: 0, measurment_units: null, unknown_future_field: "retained" };
    const transport = new MockTransport([bootstrap(), { results: [row] }]);
    const readers = await MaccabiReaders.create(transport);
    expect((await readers.listPrescriptions()).data).toEqual([row]);
    expect(transport.calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(transport.calls[1]?.init?.body))).toEqual({ members: [{ member_id: profile.member_id, member_id_code: "0" }] });
  });
  test("referrals keep observed undefined date query and original nested results", async () => {
    const row = { referral_id: "fixture-referral", referral_date: "original-date", displaying_name: "הפניה לדוגמה", pdf_link: "fixture-link", diagnoses: [{ diagnosis_name: "טקסט מקור" }] };
    const transport = new MockTransport([bootstrap(), { referrals: [row] }]);
    expect((await (await MaccabiReaders.create(transport)).listReferrals()).data).toEqual([row]);
    expect(transport.calls[1]?.path.endsWith("/referrals?from_date=undefined&to_date=undefined")).toBe(true);
  });
  test("empty appointment list stays distinct from a malformed envelope or HTTP failure", async () => {
    const transport = new MockTransport([bootstrap(), [], {}, new Response("sensitive server body", { status: 503 })]);
    const readers = await MaccabiReaders.create(transport);
    expect((await readers.listFutureAppointments()).data).toEqual([]);
    await expect(readers.listFutureAppointments()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(readers.listFutureAppointments()).rejects.toMatchObject({ code: "UPSTREAM_HTTP", status: 503 });
    expect(JSON.parse(String(transport.calls[1]?.init?.body))).toEqual({ members: [{ member_id: profile.member_id, member_id_code: "0", member_consent_for_subsidiary_information: 0 }], is_with_ascribed_doctor: true });
  });
  test("rejects cross-owner returned medical records", async () => {
    // Both halves of the check, separately: the same member id under a different member code is a
    // different person's record, and it is the only half nothing else in the suite exercises.
    for (const row of [{ member_id: "222222222" }, { member_id: String(profile.member_id), member_id_code: 9 }]) {
      const transport = new MockTransport([bootstrap(), { results: [row] }]);
      await expect((await MaccabiReaders.create(transport)).listPrescriptions()).rejects.toMatchObject({ code: "OWNER_MISMATCH", operation: "prescriptions" });
    }
    // The owner's own row, under the code the bootstrap returned, still reads.
    const mine = { doc_id: "fixture-document", drug_name: "תרופה לדוגמה", drug_instructions: "טקסט מקורי", from_date: "original-date-text", to_date: "original-date-text", member_id: String(profile.member_id), member_id_code: 0 };
    const own = new MockTransport([bootstrap(), { results: [mine] }]);
    expect((await (await MaccabiReaders.create(own)).listPrescriptions()).data).toEqual([mine]);
  });
  test("ascribed-provider timestamp is passed without timezone interpretation", async () => {
    const transport = new MockTransport([bootstrap(), { first_name: "Example", last_name: "Provider", service_provider_id: "fixture-provider" }]);
    const readers = await MaccabiReaders.create(transport);
    await readers.getAscribedProvider("2025-01-02T03:04:05");
    expect(new URL(transport.calls[1]!.path, "https://example.invalid").searchParams.get("requested_association_date")).toBe("2025-01-02T03:04:05");
    await expect(readers.getAscribedProvider("bad timestamp")).rejects.toThrow(TypeError);
  });
});

describe("laboratory results", () => {
  const summary = testRow("lab_result", { request_id: "fixture-request", doc_id: "fixture-lab" });
  const detail = { results: [{ group_name: "קבוצה לדוגמה", group_values: [{ test_id: "fixture-test", test_desc: "בדיקה לדוגמה", result: 4.2, units: "fixture-unit", min_lim: 1, max_lim: 5, message_list: ["הערת מקור"], is_follow: false }] }], execute_date: "original-date", is_partial: true };
  test("resolves only an owner lab reference and preserves values, messages and partial state", async () => {
    const transport = new MockTransport([bootstrap(), { tests: [summary], categories: [] }, detail]);
    const readers = await MaccabiReaders.create(transport);
    expect((await readers.getLabResult(summary.request_id, summary.doc_id)).data).toMatchObject(detail);
    expect(JSON.parse(String(transport.calls[1]?.init?.body))).toEqual({ members: [], categories: [], logged_user_gender: profile.sex, current_user_gender: profile.sex });
    expect(JSON.parse(String(transport.calls[2]?.init?.body))).toEqual({ request_id: summary.request_id, doc_id: summary.doc_id, logged_user_gender: profile.sex, current_user_gender: profile.sex });
  });
  test("rejects unknown IDs and mixed-owner summaries before detail request", async () => {
    for (const tests of [[], [{ ...summary, doc_id: "other-document" }], [{ ...summary, member_id: "222222222" }]]) {
      const transport = new MockTransport([bootstrap(), { tests, categories: [] }]);
      const readers = await MaccabiReaders.create(transport);
      await expect(readers.getLabResult(summary.request_id, summary.doc_id)).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
      expect(transport.calls.length).toBe(2);
    }
  });
  test("an owned row of any type reaches the detail request and is judged on the response", async () => {
    const listed = testRow("external_test_result", { request_id: summary.request_id, doc_id: summary.doc_id });
    const transport = new MockTransport([bootstrap(), { tests: [listed], categories: [] }, detail]);
    expect((await (await MaccabiReaders.create(transport)).getLabResult(summary.request_id, summary.doc_id)).data).toMatchObject(detail);
    expect(transport.calls).toHaveLength(3);
    const unusable = new MockTransport([bootstrap(), { tests: [listed], categories: [] }, { results: [] }]);
    await expect((await MaccabiReaders.create(unusable)).getLabResult(summary.request_id, summary.doc_id)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("visit history and referral documents", () => {
  const visit = { appointment_id: "fixture-visit", appointment_date: "original-date", service_provider_name: "רופא לדוגמה", service_name: "שירות לדוגמה", has_summery_file: true, member_id: String(profile.member_id), member_id_code: 0 };
  test("resolves visit from owner history and preserves original nullable clinical fields", async () => {
    const detail = { member_id: String(profile.member_id), member_id_code: "0", visit_summary_date: "source-date", service_provider_name: "רופא לדוגמה", visit_summary_pdf_link: "fixture-link", diagnosis: [{ diagnosis_description: null }], drugs: null };
    const transport = new MockTransport([bootstrap(), { results: [visit], is_psy: null }, detail]);
    const { visit_summary_pdf_link: _privatePath, ...visibleDetail } = detail;
    expect((await (await MaccabiReaders.create(transport)).getVisit(visit.appointment_id)).data).toEqual({ ...visibleDetail, has_summary_pdf: true });
    expect(transport.calls.map((call) => call.init?.method ?? "GET")).toEqual(["GET", "POST", "GET"]);
    expect(transport.calls[2]?.path.endsWith("/visits/fixture-visit")).toBe(true);
  });
  test("referral PDF derives encoded fields from a copied owner record and checks content", async () => {
    const referral = { referral_id: "fixture-referral", referral_date: "source-date", displaying_name: "מסמך לדוגמה", pdf_link: "fixture%2Ffile%20name", hash: "fixture%2Bhash", timestamp: "fixture-timestamp" };
    const transport = new MockTransport([bootstrap(), { referrals: [referral] }, new Response("%PDF-1.4\nfixture", { headers: { "content-type": "application/pdf" } })]);
    const readers = await MaccabiReaders.create(transport);
    const list = await readers.listReferrals({ from: "2025-01-01", to: "2025-12-31" });
    list.data[0]!.pdf_link = "https://outside.invalid";
    const pdf = await readers.getReferralPdf(referral.referral_id);
    expect(new TextDecoder().decode(pdf.data)).toBe("%PDF-1.4\nfixture");
    const url = new URL(transport.calls[2]!.path, "https://example.invalid");
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: "fixture/file name", hash: "fixture+hash", timestamp: "fixture-timestamp" });
    expect(transport.calls[2]?.init).toMatchObject({ apiAuthorization: false });
    await expect(readers.listReferrals({ from: "2025-02-30", to: "2025-03-01" })).rejects.toThrow(TypeError);
  });
  test("document HTML/login or malformed PDF is not returned as a clinical PDF", async () => {
    const referral = { referral_id: "fixture-referral", referral_date: "source-date", displaying_name: "מסמך לדוגמה", pdf_link: "fixture", hash: "fixture", timestamp: "fixture" };
    const transport = new MockTransport([bootstrap(), { referrals: [referral] }, new Response("<html>login</html>", { headers: { "content-type": "text/html" } })]);
    await expect((await MaccabiReaders.create(transport)).getReferralPdf(referral.referral_id)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("bounded appointment discovery", () => {
  const reference = { object_type: "S", object_id: "fixture-object", employee_id: "fixture-employee" };
  const recent = { ...reference, pactitioner_name_title: "רופא לדוגמה", practitioner_id: "fixture-practitioner", clinic_address: { city: "עיר לדוגמה" } };
  const provider = { provider_id: "fixture-provider", facility_id: "fixture-clinic", provider_role: "fixture-role", sap_key: { object_type: reference.object_type, object_Id: reference.object_id, employee_id: reference.employee_id } };
  const account = () => {
    const data = bootstrap();
    Object.assign(data.logged_customer_info, { age: { years: 25 }, phones: [{ phone_type: "ב", phone_prefix: "00", phone_no: 1111111 }, { phone_type: "נ", phone_prefix: "00", phone_no: 2222222 }] });
    return data;
  };
  const source = () => new Response(`var api="/sonline/AppointmentOrderAPI/webapi/mac/",key="${"a".repeat(32)}"; const paths=["/odoro/session","/odoro/dialog"];`, { headers: { "content-type": "application/javascript" } });
  const start = () => ({ session_id: "fixture-dialogue-session", request: { "@type": "options", options: { opt: [{ code: "1", description: "תור טלפוני" }, { code: "2", description: "תור במרפאה" }] }, appoint: null, end: null } });
  test("returns source days/times after clinic mode and never submits a slot or exposes session material", async () => {
    const availability = { appointment_id: null, session_id: "fixture-dialogue-session", message: ["בחרו תור"], request: { "@type": "appoint", end: null, appoint: { months: { view_month: "source-month", first_month: "source-month", last_month: "source-month" }, days: { day: [{ dayDate: "source-day", times: { time: ["0910", "1040"] } }] } } } };
    const transport = new MockTransport([account(), [recent], { is_eligible: true, future_appointments: [] }, { providers: { provider: [provider] } }, source(), start(), availability]);
    const result = await (await MaccabiReaders.create(transport)).getClinicAvailability(reference);
    expect(result.data.days).toEqual([{ dayDate: "source-day", times: ["0910", "1040"] }]);
    expect(JSON.stringify(result)).not.toContain("fixture-dialogue-session");
    expect(JSON.stringify(result)).not.toContain("a".repeat(32));
    const dialogueCalls = transport.calls.filter((call) => call.path.includes("/odoro/"));
    expect(dialogueCalls.length).toBe(2);
    expect(JSON.parse(String(dialogueCalls[0]?.init?.body))).toEqual({ move_event_id: "0", authentication: "a".repeat(32), provider_id: provider.provider_id, facility_code: provider.facility_id, provider_role: provider.provider_role, member_phone: "00-1111111", member_other_phone: "00-2222222", member_first_name: profile.f_name_hebrew, member_last_name: profile.l_name_hebrew });
    expect(JSON.parse(String(dialogueCalls[1]?.init?.body))).toEqual({ session_id: "fixture-dialogue-session", authentication: "a".repeat(32), response: "2" });
  });
  test("unknown dialogue choice stops without sending response; ineligibility stops before session", async () => {
    const changed = start(); changed.request.options.opt[1]!.description = "פעולה לא מוכרת";
    const transport = new MockTransport([account(), [recent], { is_eligible: true, future_appointments: [] }, { providers: { provider: [provider] } }, source(), changed]);
    await expect((await MaccabiReaders.create(transport)).getClinicAvailability(reference)).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW" });
    expect(transport.calls.some((call) => call.path.endsWith("/odoro/dialog"))).toBe(false);
    const denied = new MockTransport([account(), [recent], { is_eligible: false, future_appointments: [] }]);
    await expect((await MaccabiReaders.create(denied)).getClinicAvailability(reference)).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    expect(denied.calls.length).toBe(3);
  });
  test("refuses changed static authentication source before starting a dialogue", async () => {
    const transport = new MockTransport([account(), [recent], { is_eligible: true, future_appointments: [] }, { providers: { provider: [provider] } }, new Response("<html>login</html>")]);
    await expect((await MaccabiReaders.create(transport)).getClinicAvailability(reference)).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW" });
    expect(transport.calls.some((call) => call.path.includes("/odoro/"))).toBe(false);
  });
});

describe("appointment changed-response fail-safe checks", () => {
  const reference = { object_type: "S", object_id: "fixture-object", employee_id: "fixture-employee" };
  const recent = { ...reference, pactitioner_name_title: "רופא לדוגמה", practitioner_id: "fixture-provider", clinic_address: {} };
  const provider = { provider_id: "fixture-provider", facility_id: "fixture-clinic", provider_role: "fixture-role", sap_key: { object_type: "S", object_Id: reference.object_id, employee_id: reference.employee_id } };
  const account = () => { const data = bootstrap(); Object.assign(data.logged_customer_info, { age: { years: 25 }, phones: [] }); return data; };
  const source = () => new Response(`var api="/sonline/AppointmentOrderAPI/webapi/mac/",key="${"b".repeat(32)}";const paths=["/odoro/session","/odoro/dialog"];`, { headers: { "content-type": "application/javascript" } });
  const start = () => ({ session_id: "fixture-session", request: { "@type": "options", options: { opt: [{ code: "2", description: "תור במרפאה" }] }, appoint: null, end: null } });
  test("existing future appointments stop before provider details, source or scheduler session", async () => {
    const transport = new MockTransport([account(), [recent], { is_eligible: true, future_appointments: [{ appointment_id: "existing-fixture" }] }]);
    await expect((await MaccabiReaders.create(transport)).getClinicAvailability(reference)).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW" });
    expect(transport.calls.length).toBe(3);
  });
  test("unexpected appointment id in initial session stops before mode response", async () => {
    const transport = new MockTransport([account(), [recent], { is_eligible: true, future_appointments: [] }, { providers: { provider: [provider] } }, source(), { ...start(), appointment_id: "unexpected-fixture" }]);
    await expect((await MaccabiReaders.create(transport)).getClinicAvailability(reference)).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW" });
    expect(transport.calls.some((call) => call.path.endsWith("/odoro/dialog"))).toBe(false);
  });
  test("returns only observed month fields even if upstream adds nested session material", async () => {
    const availability = { appointment_id: null, message: [], request: { "@type": "appoint", end: null, appoint: { months: { view_month: "one", first_month: "one", last_month: "two", secret: { authentication: "not-for-output", session_id: "not-for-output" } }, days: { day: [] } } } };
    const transport = new MockTransport([account(), [recent], { is_eligible: true, future_appointments: [] }, { providers: { provider: [provider] } }, source(), start(), availability]);
    const result = await (await MaccabiReaders.create(transport)).getClinicAvailability(reference);
    expect(result.data.months).toEqual({ view_month: "one", first_month: "one", last_month: "two" });
    expect(JSON.stringify(result)).not.toContain("not-for-output");
  });
  test("arbitrary provider references and mismatched provider echo fail before scheduling", async () => {
    const unknown = new MockTransport([account(), [recent]]);
    await expect((await MaccabiReaders.create(unknown)).getAppointmentProvider({ ...reference, object_id: "not-a-source-reference" })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    const mismatch = new MockTransport([account(), [recent], { providers: { provider: [{ ...provider, sap_key: { ...provider.sap_key, object_Id: "not-the-request" } }] } }]);
    await expect((await MaccabiReaders.create(mismatch)).getAppointmentProvider(reference)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(mismatch.calls.length).toBe(3);
  });
});

describe("local test execution-year filtering", () => {
  const testRow = (execution: string, result: string, request: string) => ({ request_id: request, doc_id: `fixture-${request}`, type: "lab_result", execute_date: execution, result_date: result, test_name: ["בדיקה לדוגמה"], member_id: String(profile.member_id), member_id_code: 0 });
  test("uses written execution year at both boundaries, preserves values, adds no server filter", async () => {
    const rows = [
      testRow("2024-12-31T23:59:59", "2025-01-01T00:00:00", "before"),
      testRow("2025-01-01T00:00:00", "2025-01-02T00:00:00", "start"),
      testRow("2025-12-31T23:59:59", "2026-01-01T00:00:00", "end"),
      testRow("2026-01-01T00:00:00", "2026-01-02T00:00:00", "after"),
    ];
    const transport = new MockTransport([bootstrap(), { categories: [], tests: rows }]);
    const result = await (await MaccabiReaders.create(transport)).listTests({ year: 2025 });
    expect(result.data.tests).toEqual([{ ...rows[1]!, has_document: false }, { ...rows[2]!, has_document: false }]);
    expect(result.source).toMatchObject({ completeness: "local-filtered-subset", selection: { mode: "local", field: "execute_date", year: 2025 } });
    expect(transport.calls.length).toBe(2);
    expect(transport.calls[1]?.path.endsWith("/tests")).toBe(true);
    expect(JSON.parse(String(transport.calls[1]?.init?.body))).toEqual({ members: [], categories: [], logged_user_gender: profile.sex, current_user_gender: profile.sex });
  });
  test("malformed/new date format fails explicitly rather than silently dropping a record", async () => {
    for (const execution of ["2025-02-30T00:00:00", "2025-01-01T00:00:00Z", "unknown-date"]) {
      const transport = new MockTransport([bootstrap(), { categories: [], tests: [testRow(execution, "source-result-date", "bad")] }]);
      await expect((await MaccabiReaders.create(transport)).listTests({ year: 2025 })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });
  test("valid unmatched year is a labeled empty subset; invalid year sends no list request", async () => {
    const transport = new MockTransport([bootstrap(), { categories: [], tests: [testRow("2024-02-29T00:00:00", "original-result", "leap")] }]);
    const readers = await MaccabiReaders.create(transport);
    const result = await readers.listTests({ year: 2025 });
    expect(result.data.tests).toEqual([]);
    expect(result.source.completeness).toBe("local-filtered-subset");
    for (const year of [25, 2025.5, NaN]) await expect(readers.listTests({ year })).rejects.toThrow(TypeError);
    expect(transport.calls.length).toBe(2);
  });
});

describe("expanded medical menu reads", () => {
  test("vaccination groups preserve observed clinical fields and source reference while excluding document signatures", async () => {
    const group = { vaccine_group_code: 101, vaccinations_amount: 2, vaccine_group_name: "חיסון לדוגמה", first_date: "original-first-date", last_date: "original-last-date", timestamp: "source-timestamp", hash: "synthetic-signature" };
    const transport = new MockTransport([bootstrap(), { timeline: [group], hash: "synthetic-report-signature", timestamp: "report-timestamp" }]);
    const result = await (await MaccabiReaders.create(transport)).listVaccinationGroups();
    const { hash, ...clinical } = group;
    expect(result.data).toEqual([clinical]);
    expect(transport.calls[1]?.path.endsWith("/vaccinations_grouped")).toBe(true);
    expect(transport.calls[1]?.init?.method ?? "GET").toBe("GET");
    expect(JSON.stringify(result)).not.toContain("signature");
  });
  test("sensitivities distinguish observed empty collection, unsupported populated schema, and malformed response", async () => {
    const transport = new MockTransport([bootstrap(), { intolerance: [] }, { intolerance: [{ synthetic_unobserved: true }] }, {}]);
    const readers = await MaccabiReaders.create(transport);
    expect((await readers.listSensitivities()).data).toEqual([]);
    await expect(readers.listSensitivities()).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW", operation: "sensitivities" });
    await expect(readers.listSensitivities()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(transport.calls[1]?.path.endsWith("/sensitivity")).toBe(true);
  });
});

test("vaccination reference/count reject unsafe, fractional and negative integers", async () => {
  for (const field of ["vaccine_group_code", "vaccinations_amount"]) for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const row = { vaccine_group_code: 1, vaccinations_amount: 1, vaccine_group_name: "synthetic", first_date: "original", last_date: "original", timestamp: "original", [field]: value };
    const readers = await MaccabiReaders.create(new MockTransport([bootstrap(), { timeline: [row] }]));
    await expect(readers.listVaccinationGroups()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  }
});

describe("vaccination certificate and existing inquiries", () => {
  const inquiry = () => ({ member_id: String(profile.member_id), member_id_code: 0, request_id: "314", type: "medical_form_request", service_provider_name: "רופא לדוגמה", request_status: "טקסט מקור", status_update_date: "original-date", request_subjects: [{ id: 1, name: "נושא מקורי" }], medical_forms_documents: [{ result_file: "private-routing", hash: "private-signature" }] });
  const detail = () => ({ request_id: 314, user_id: profile.member_id, user_code: 0, patient_remark: "טקסט רפואי מקורי", doctor_remark: "תשובה מקורית", creation_date: "original-date", update_date: "original-date", doctor_name: "רופא לדוגמה", request_status_desc: "טקסט מקור", prescription_largo_code_list: [], approval_request_details: [], prescription_user_drugs_indication: [], patient_full_name: "unnecessary identity", patient_phone: "unnecessary phone", hash: "private-signature", medical_forms_details: [{ document_id: 42, document_description: "מסמך מקורי", link_pdf: "private-routing", token: "private-token", hash: "private-signature" }] });
  test("certificate validates observed type/base64/PDF and preserves original bytes", async () => {
    const bytes = "%PDF-1.7\nsynthetic original document";
    const transport = new MockTransport([bootstrap(), { type: "pdf", base64: btoa(bytes) }]);
    const result = await (await MaccabiReaders.create(transport)).getVaccinationCertificatePdf();
    expect(new TextDecoder().decode(result.data)).toBe(bytes);
    expect(result.source.operation).toBe("vaccination-certificate-pdf");
    expect(transport.calls[1]?.path.endsWith("/vaccination/certificates/report")).toBe(true);
    for (const response of [{ type: "html", base64: btoa(bytes) }, { type: "pdf", base64: btoa("<html>login</html>") }, { type: "pdf", base64: "%%invalid%%" }]) {
      const readers = await MaccabiReaders.create(new MockTransport([bootstrap(), response]));
      await expect(readers.getVaccinationCertificatePdf()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });
  test("inquiries bind owner/reference and preserve clinical prose while omitting routing signatures", async () => {
    const transport = new MockTransport([bootstrap(), { inquiries: [inquiry()] }, detail()]);
    const readers = await MaccabiReaders.create(transport);
    const list = await readers.listInquiries();
    expect(list.data[0]?.request_subjects).toEqual([{ id: 1, name: "נושא מקורי" }]);
    list.data[0]!.type = "mutated-by-caller";
    const result = await readers.getInquiry("314");
    expect(result.data.patient_remark).toBe("טקסט רפואי מקורי");
    expect(result.data.medical_forms_details).toEqual([{ document_id: 42, document_description: "מסמך מקורי" }]);
    expect(JSON.stringify(result)).not.toMatch(/private-|unnecessary|user_id|user_code/);
    expect(transport.calls.map(call => call.init?.method ?? "GET")).toEqual(["GET", "GET", "GET"]);
    expect(transport.calls[2]?.path.endsWith("/inquiries/314/details")).toBe(true);
  });
  test("unknown reference/type and wrong owner echo stop safely; unobserved nested detail is explicit", async () => {
    for (const [row, id, code] of [[inquiry(), "unknown", "OWNER_MISMATCH"], [{ ...inquiry(), type: "automatic_sick_permit", medical_forms_documents: [] }, "314", "UNSUPPORTED_FLOW"], [{ ...inquiry(), member_id: "other-owner" }, "314", "OWNER_MISMATCH"]] as const) {
      const transport = new MockTransport([bootstrap(), { inquiries: [row] }]);
      await expect((await MaccabiReaders.create(transport)).getInquiry(id)).rejects.toMatchObject({ code });
      expect(transport.calls).toHaveLength(2);
    }
    for (const changed of [{ user_id: 999 }, { request_id: 999 }]) {
      const readers = await MaccabiReaders.create(new MockTransport([bootstrap(), { inquiries: [inquiry()] }, { ...detail(), ...changed }]));
      await expect(readers.getInquiry("314")).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    }
    const prescription = await MaccabiReaders.create(new MockTransport([bootstrap(), { inquiries: [inquiry()] }, { ...detail(), prescription_largo_code_list: [{ drug_name: "תרופה מקורית", private_code: "omit" }] }]));
    await expect(prescription.getInquiry("314")).resolves.toMatchObject({ data: { prescription_largo_code_list: [{ drug_name: "תרופה מקורית" }] } });
  });
});

test("inquiry derives associated visit internally, validates owner and projects clinical fields", async () => {
  const row = { member_id: String(profile.member_id), member_id_code: 0, request_id: "314", type: "medical_form_request", service_provider_name: "synthetic", request_status: "original", status_update_date: "original" };
  const detail = { request_id: 314, user_id: profile.member_id, user_code: 0, patient_remark: "original", doctor_remark: "original", creation_date: "original", update_date: "original", doctor_name: "original", request_status_desc: "original", prescription_largo_code_list: [], approval_request_details: [], prescription_user_drugs_indication: [], medical_forms_details: [], open_medical_record_number: "internal-reference" };
  const visit = { member_id: String(profile.member_id), member_id_code: "0", visit_summary_date: "original-date", diagnosis: [{ diagnosis_description: null }], visit_summary_pdf_link: "private-routing", hash: "private-hash", referrals: [{ referral_id: "synthetic-ref", referral_displaying_name: "מקור", referral_pdf_link: "private-routing", hash: "private-hash" }] };
  const transport = new MockTransport([bootstrap(), { inquiries: [row] }, detail, visit]);
  const result = await (await MaccabiReaders.create(transport)).getInquiry("314");
  expect(transport.calls[3]?.path.endsWith("/visits/internal-reference/?isOpenMedicalRecordNumber=true")).toBe(true);
  expect((result.data.visit_summary as { data: unknown }).data).toEqual({ visit_summary_date: "original-date", diagnosis: [{ diagnosis_description: null }], has_summary_pdf:true, summary_pdf_reference:expect.stringMatching(/^[a-f0-9]{64}$/), referrals: [{ referral_id: "synthetic-ref", referral_displaying_name: "מקור",pdf_reference:expect.stringMatching(/^[a-f0-9]{64}$/) }] });
  expect(JSON.stringify(result)).not.toMatch(/internal-reference|private-|member_id/);
  const wrong = new MockTransport([bootstrap(), { inquiries: [row] }, detail, { ...visit, member_id: "other" }]);
  await expect((await MaccabiReaders.create(wrong)).getInquiry("314")).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
});

describe("frontend-derived empty-account projections and English summary", () => {
  test("sensitivity display projection is labeled source-only and retains original scalars/nulls", async () => {
    const row = { registration_date: "source date", sensitivity: "טקסט רגישות מקורי", practitioner_name: null, speciality: "מקור", sensitivity_presentation: "מקור", classification: "מקור", hash: "private", extra: { token: "private" } };
    const reader = await MaccabiReaders.create(new MockTransport([bootstrap(), { intolerance: [row] }]));
    const result = await reader.listSensitivities();
    const { hash, extra, ...expected } = row;
    expect(result.data).toEqual([expected]);
    expect(result.source.schemaEvidence).toBe("frontend-field-projection");
    const invalid = await MaccabiReaders.create(new MockTransport([bootstrap(), { intolerance: [{ registration_date: "date", sensitivity: { unknown: true } }] }]));
    await expect(invalid.listSensitivities()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  test("administrative list uses owner-only retrieval POST and fixed timeline fields", async () => {
    const row = { member_id: String(profile.member_id), member_id_code: 0, interaction_id: "synthetic-ref", classification: "case", type_name: "בקשה", status: "מקור", status_update_date: "original", has_content: true, is_read: false, obligation_provider_name: null, expand_data: { token: "private" }, uri: "private" };
    const transport = new MockTransport([bootstrap(), [row], []]);
    const readers = await MaccabiReaders.create(transport);
    const result = await readers.listAdministrativeRequests();
    expect(result.data).toEqual([{ interaction_id: "synthetic-ref", classification: "case", type_name: "בקשה", status: "מקור", status_update_date: "original", has_content: true, is_read: false, obligation_provider_name: null }]);
    expect(result.source.schemaEvidence).toBe("frontend-field-projection");
    expect(transport.calls[1]?.path.endsWith("/requests_and_cases")).toBe(true);
    expect(transport.calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(transport.calls[1]?.init?.body))).toEqual({ members: [{ member_id_code: "0", member_id: profile.member_id }] });
    expect((await readers.listAdministrativeRequests()).data).toEqual([]);
    for (const bad of [{ ...row, member_id: "other" }, { ...row, status: {} }, { ...row, interaction_id: null }, { ...row, interaction_id: "" }, { member_id: profile.member_id }]) {
      const reader = await MaccabiReaders.create(new MockTransport([bootstrap(), [bad]]));
      await expect(reader.listAdministrativeRequests()).rejects.toBeInstanceOf(ReadOperationError);
    }
  });
  test("English summary resolves fresh metadata, sends cookie-only PDF GET and preserves encoded hash once", async () => {
    const transport = new MockTransport([bootstrap(), { timestamp: "synthetic time", hash: "synthetic%2Fhash%3D%3D" }, new Response("%PDF-1.7\nsynthetic document", { headers: { "content-type": "application/pdf" } })]);
    const result = await (await MaccabiReaders.create(transport)).getEnglishMedicalSummaryPdf();
    expect(new TextDecoder().decode(result.data)).toBe("%PDF-1.7\nsynthetic document");
    expect(result.source.service).toBe("DirectorshipAPI");
    expect(transport.calls[1]?.path.endsWith("/timestampAndHash")).toBe(true);
    const pdf = transport.calls[2]!;
    expect(pdf.path).toContain("/report/english/?");
    expect(pdf.path).toContain("hash=synthetic%2Fhash%3D%3D");
    expect(pdf.path).not.toContain("%25");
    expect(pdf.init).toEqual({ apiAuthorization: false });
    expect(transport.calls.every(call => call.init?.method === undefined)).toBe(true);
    const invalid = await MaccabiReaders.create(new MockTransport([bootstrap(), { timestamp: "synthetic", hash: "synthetic" }, new Response("<html>unavailable</html>", { headers: { "content-type": "text/html" } })]));
    await expect(invalid.getEnglishMedicalSummaryPdf()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("purchased medication report and financial metadata", () => {
  test("medication report uses the observed original-PDF envelope without inventing a history range", async () => {
    const transport = new MockTransport([bootstrap(), { type: "pdf", base64: btoa("%PDF-1.7\nsynthetic medication report") }]);
    const result = await (await MaccabiReaders.create(transport)).getMedicationReportPdf();
    expect(transport.calls[1]?.path.endsWith("/prescriptions/purchased/report")).toBe(true);
    expect(new TextDecoder().decode(result.data)).toBe("%PDF-1.7\nsynthetic medication report");
    expect(result.source.operation).toBe("medication-report-pdf");
  });
  test("payment metadata fixed projection omits full account and authority material", async () => {
    const row = { is_active_auth_exists: false, payment_method: 0, bank_code: 0, bank_name: "original", branch_code: 0, branch_name: "original", account_number: 987654321, credit_card_type: "original", last_four_digits_credit_card: "1234", is_credit_auth_only: false, auth_start_date: null, payer_type: 1, is_shaban_auth_only: false, token: "private" };
    const transport = new MockTransport([bootstrap(), row]);
    const result = await (await MaccabiReaders.create(transport)).getPaymentMethods();
    const { account_number, token, ...expected } = row;
    expect(result.data).toEqual(expected);
    expect(transport.calls[1]?.path).toBe(`/sonline/DirectorshipAPI/webapi/mac/v1/payers/0/${profile.member_id}/debit_authorization`);
    expect(JSON.stringify(result)).not.toMatch(/987654321|private|account_number/);
  });
  test("debt totals support only observed other-payer branch and disclose aggregate scope", async () => {
    const login = bootstrap(); Object.assign(login.logged_customer_info, { pays_id: 999 });
    const transport = new MockTransport([login, { kupa_debt: 1.25, shaban_debt: 2, additional_charges_debt: 0, token: "private" }]);
    const result = await (await MaccabiReaders.create(transport)).getOutstandingDebt();
    expect(transport.calls[1]?.path.endsWith("/finance/debts?person_type=1")).toBe(true);
    expect(result.data).toEqual({ kupa_debt: 1.25, shaban_debt: 2, additional_charges_debt: 0 });
    expect(result.source.scope).toBe("payer-account-aggregate");
    for (const payer of [undefined, profile.member_id]) {
      const data = bootstrap(); Object.assign(data.logged_customer_info, { pays_id: payer });
      const blocked = new MockTransport([data]);
      await expect((await MaccabiReaders.create(blocked)).getOutstandingDebt()).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW" });
      expect(blocked.calls).toHaveLength(1);
    }
  });
  test("reader body timeouts preserve transport classification rather than malformed-record errors", async () => {
    for (const kind of ["json", "arrayBuffer"] as const) {
      const response = kind === "json" ? Response.json({}) : new Response("", { headers: { "content-type": "application/pdf" } });
      Object.defineProperty(response, kind, { value: async () => { throw new DOMException("synthetic timeout", "TimeoutError"); } });
      const transport = new MockTransport(kind === "json" ? [bootstrap(), response] : [bootstrap(), { timestamp: "synthetic", hash: "synthetic" }, response]);
      const readers = await MaccabiReaders.create(transport);
      await expect(kind === "json" ? readers.listInquiries() : readers.getEnglishMedicalSummaryPdf()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    }
  });
});

describe("medical certificates", () => {
  const range = { from: "2024-01-01", to: "2026-12-31" };
  const certificate = () => ({ title_name: "אישור לדוגמה", practitioner_full_name: "רופא לדוגמה", specialization_description: "מקור", approval_date: "2025-01-01", approval_date_from: "2025-01-01", approval_date_to: "2025-02-01", approval_type_code: "synthetic-type", pdf_link: "fixture%2Fdocument", timestamp: "synthetic-time", hash: "synthetic%2Bsignature" });
  test("list projects clinical fields and creates stable local references without exposing document access data", async () => {
    const transport = new MockTransport([bootstrap(), { approval: [certificate()] }, { approval: [{ ...certificate(), hash: "rotated-signature", timestamp: "rotated-time" }] }, new Response("%PDF-1.7\nsynthetic", { headers: { "content-type": "application/pdf" } })]);
    const reader = await MaccabiReaders.create(transport);
    const result = await reader.listCertificates(range);
    const reference = result.data[0]!.reference;
    expect(reference).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data[0]?.title_name).toBe("אישור לדוגמה");
    expect(JSON.stringify(result)).not.toMatch(/fixture|signature|pdf_link|timestamp/);
    expect(transport.calls[1]?.path.endsWith("/approvals?from_date=2024-01-01&to_date=2026-12-31")).toBe(true);
    expect((await reader.listCertificates(range)).data[0]?.reference).toBe(reference);
    result.data[0]!.pdf_link = "caller-injected";
    const pdf = await reader.getCertificatePdf(reference, range);
    expect(new TextDecoder().decode(pdf.data)).toBe("%PDF-1.7\nsynthetic");
    expect(new URL(transport.calls[3]!.path, "https://synthetic.invalid").searchParams.get("path")).toBe("fixture/document");
    expect(transport.calls[3]?.init?.apiAuthorization).toBe(false);
  });
  test("invalid dates, unknown reference and duplicate ambiguous document references fail safely", async () => {
    const transport = new MockTransport([bootstrap(), { approval: [] }]);
    const reader = await MaccabiReaders.create(transport);
    await expect(reader.listCertificates({ from: "2025-02-30", to: "2025-03-01" })).rejects.toBeInstanceOf(TypeError);
    expect(transport.calls).toHaveLength(1);
    await expect(reader.getCertificatePdf("unknown", range)).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(transport.calls).toHaveLength(2);
    const duplicate = await MaccabiReaders.create(new MockTransport([bootstrap(), { approval: [certificate(), certificate()] }]));
    await expect(duplicate.listCertificates(range)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("owner-bound imaging documents", () => {
  const row = (type: SourceTestRowType = "imaging_result", overrides: Partial<SourceTestRow> = {}) =>
    testRow(type, { request_id: "imaging-request", doc_id: "imaging-document", ...overrides });
  test("derives signed PDF query and owner/header fields from copied list; never marks read", async () => {
    const owner = bootstrap(); owner.logged_customer_info.sex = "נ"; owner.current_customer_info.sex = "נ";
    const transport = new MockTransport([owner, { categories: [], tests: [row()] }, new Response("%PDF-1.7\nsynthetic imaging", { headers: { "content-type": "application/pdf" } })]);
    const reader = await MaccabiReaders.create(transport);
    const listed = await reader.listTests(); listed.data.tests[0]!.hash = "caller-mutated";
    const result = await reader.getImagingResultPdf("imaging-request", "imaging-document");
    const path = transport.calls[2]!.path;
    expect(path).toContain("&hash=synthetic%2Fhash%3D%3D&");
    expect(path).not.toContain("%25");
    const query = new URL(path, "https://synthetic.invalid").searchParams;
    expect(Object.fromEntries(query)).toEqual({ memberidcode: "0", memberid: String(profile.member_id), data: "imaging-document", t: "synthetic-time", hash: "synthetic/hash==", loggedInUserGender: "2", currentUsergender: "2", memberIdForHeader: String(profile.member_id), memberIdCodeForHeader: "0" });
    expect(transport.calls[2]?.init).toEqual({ apiAuthorization: false });
    expect(transport.calls).toHaveLength(3);
    expect(new TextDecoder().decode(result.data)).toBe("%PDF-1.7\nsynthetic imaging");
    expect(result.source.operation).toBe("imaging-result-pdf");
  });
  test("downloads any listed type that carries a document, keyed on doc_id not the attachment path", async () => {
    for (const type of ["external_test_result", "unobserved_future_type"]) {
      // The unobserved type stands in for a row of a type this client has never seen that still ships a document.
      const record = row("external_test_result", { type, request_id: "external-request", doc_id: "external-document" });
      const transport = new MockTransport([bootstrap(), { categories: [], tests: [record] }, new Response("%PDF-1.7\nsynthetic external", { headers: { "content-type": "application/pdf" } })]);
      const result = await (await MaccabiReaders.create(transport)).getImagingResultPdf("external-request", "external-document");
      const query = new URL(transport.calls[2]!.path, "https://synthetic.invalid").searchParams;
      expect(query.get("data")).toBe("external-document");
      expect(transport.calls[2]!.path).not.toContain("attachment");
      expect(new TextDecoder().decode(result.data)).toBe("%PDF-1.7\nsynthetic external");
    }
  });
  test("unknown references and rows with no attached document stop before the document request", async () => {
    const cases = [
      [row(), "unknown", "imaging-document", "OWNER_MISMATCH"],
      // Ownership is decided on the whole pair, so a doc_id the list never carried is a mismatch, not an
      // unsupported flow, even when the request_id beside it is genuinely this owner's.
      [row(), "imaging-request", "unlisted-document", "OWNER_MISMATCH"],
      [row("lab_result"), "imaging-request", "imaging-document", "UNSUPPORTED_FLOW"],
      [row("imaging_study"), "imaging-request", "imaging-document", "UNSUPPORTED_FLOW"],
      [row("imaging_study", { result_files: [] }), "imaging-request", "imaging-document", "UNSUPPORTED_FLOW"],
      [row("imaging_result", { result_files: [{ result_file: "" }] }), "imaging-request", "imaging-document", "UNSUPPORTED_FLOW"],
      [row("imaging_result", { result_files: [{ result_file: " " }] }), "imaging-request", "imaging-document", "UNSUPPORTED_FLOW"],
    ] as const;
    for (const [record, requestId, docId, code] of cases) {
      const transport = new MockTransport([bootstrap(), { categories: [], tests: [record] }]);
      await expect((await MaccabiReaders.create(transport)).getImagingResultPdf(requestId, docId)).rejects.toMatchObject({ code });
      expect(transport.calls).toHaveLength(2);
    }
  });
  test("the list marks which rows carry a document, read from the attachment field and never from the type", async () => {
    const rows = [
      testRow("lab_result", { request_id: "lab", doc_id: "lab-document" }),
      testRow("imaging_result", { request_id: "imaging", doc_id: "imaging-document" }),
      testRow("external_test_result", { request_id: "external", doc_id: "external-document" }),
      testRow("imaging_study", { request_id: "study", doc_id: "study-document" }),
      // A type this client has never seen that still ships a document, and a known imaging type with its
      // attachment emptied. The flag follows the attachment in both, which a lookup on type could not do.
      testRow("lab_result", { type: "unobserved_future_type", request_id: "future", doc_id: "future-document", result_files: [{ result_file: "synthetic/attachment/path" }] }),
      testRow("imaging_result", { request_id: "blank", doc_id: "blank-document", result_files: [{ result_file: " " }] }),
    ];
    const transport = new MockTransport([bootstrap(), { categories: [], tests: rows }]);
    const listed = (await (await MaccabiReaders.create(transport)).listTests()).data.tests;
    expect(listed.map(test => [test.request_id, test.has_document])).toEqual([
      ["lab", false], ["imaging", true], ["external", true], ["study", false], ["future", true], ["blank", false],
    ]);
  });
});

test("additional-information descriptions use source-derived fields without exposing arbitrary URLs", async () => {
  const range = { from: "2025-01-01", to: "2026-01-01" };
  const row = { url: "https://synthetic.invalid/private", session_datetime: "source-date", display_text: "טקסט מקור", practitioner_name: null, specialization: "מקור", type_id: 1, hash: "private", timestamp: "private" };
  const transport = new MockTransport([bootstrap(), { tutorials: [] }, { tutorials: [row] }, { tutorials: [{ ...row, type_id: 99 }] }]);
  const reader = await MaccabiReaders.create(transport);
  expect((await reader.listAdditionalInformation(range)).data).toEqual([]);
  const result = await reader.listAdditionalInformation(range);
  expect(result.data).toMatchObject([{ session_datetime: "source-date", display_text: "טקסט מקור", practitioner_name: null, specialization: "מקור", type_id: 1 }]);
  expect(result.data[0]!.reference).toMatch(/^[a-f0-9]{64}$/);
  expect(result.source.schemaEvidence).toBe("frontend-field-projection");
  expect(transport.calls[1]?.path.endsWith("/tutorials?from_date=2025-01-01&to_date=2026-01-01")).toBe(true);
  await expect(reader.listAdditionalInformation(range)).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW" });
});

describe("legacy owner session handoff and structured medical reads", () => {
  const ownerHeader = `<header><div style="display:none"><span id="ctl00_ctl00_wcSiteHeaderLobby1_wcSiteHeaderCurrentPatient_wcSiteHeaderChildrenList_lblCustomerIDNumber">${profile.member_id}</span></div></header>`;
  const grid = (width: number) => `<ul class="appList"><li><table><thead><tr>${Array.from({ length: width }, (_, i) => `<th>Label ${i}</th>`).join("")}</tr></thead></table></li><li><table><tbody><tr>${Array.from({ length: width }, (_, i) => `<td>Original ${i}</td>`).join("")}</tr></tbody></table></li></ul>`;
  const recommendations = `${ownerHeader}<div class="recommendationsTitle"><h2>Title</h2></div><div class="personal-recommendations-details"><div class="medicalReInfo">Context</div><div class="medicalReSubject"><a>Group</a><div class="medicalReSubjectInner">${grid(2)}</div></div><div class="commentBlock">Original limitation</div></div>`;
  const summary = `${ownerHeader}<div id="summery"><div class="medicalFileDesc">Original description</div><div id="drugs"><h3>Medication labels</h3><div class="summeryInnerTitle"><p>Source period</p></div>${grid(2)}</div><div id="labResults"><h3>Lab labels</h3><div class="summeryInnerTitle"><div class="table-cell">Source period</div></div>${grid(4)}</div></div>`;
  const hospital = `${ownerHeader}<div id="mailingsFromHospitalsController"></div><script>jqe.appRoot='/online';var pageSettings={"YearsBack":"3"};</script>`;
  const login = () => ({ ...bootstrap(), session_id: "synthetic-bootstrap-seed" });
  const html = (body: string, url?: string) => { const response = new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }); if (url) Object.defineProperty(response, "url", { value: url }); return response; };
  class LegacyMock extends MockTransport {
    navigationCalls: unknown[] = [];
    async getOrCreatePortalNavigationSession(owner: unknown, seed: string) { this.navigationCalls.push({ owner, seed }); return "persisted+/session"; }
  }
  test("fresh handoff uses persisted owner cookie, fixed owner route, and emits only parsed medical content", async () => {
    const transport = new LegacyMock([login(), html(recommendations), html(summary)]);
    const readers = await MaccabiReaders.create(transport);
    const rec = await readers.getMedicalRecommendations();
    const selected = await readers.getSelectedMedicalSummary();
    expect(rec.data.sections[0]?.table.rows).toEqual([["Original 0", "Original 1"]]);
    expect(selected.data.laboratory.table.rows).toEqual([["Original 0", "Original 1", "Original 2", "Original 3"]]);
    const navigation = new URL(transport.calls[1]!.path, "https://synthetic.invalid");
    expect(navigation.pathname).toBe("/online/medicalfile/personalrecommendations/");
    expect(Object.fromEntries(navigation.searchParams)).toEqual({ relative: "-1", sr_id: "persisted+/session" });
    expect(transport.calls[1]?.init?.apiAuthorization).toBe(false);
    expect(transport.navigationCalls[0]).toEqual({ owner: { memberId: profile.member_id, memberIdCode: "0" }, seed: "synthetic-bootstrap-seed" });
    expect(JSON.stringify([rec, selected])).not.toMatch(/123456789|session|bootstrap/);
  });
  test("legacy Windows-1255 bytes preserve Hebrew; unsupported or malformed encodings fail", async () => {
    const source = recommendations.replace("Context", "שלום");
    const encoded = Uint8Array.from([...source].map(character => {
      const code = character.codePointAt(0)!;
      if (code >= 0x05d0 && code <= 0x05ea) return 0xe0 + code - 0x05d0;
      if (code > 127) throw new Error("Synthetic fixture includes an unmapped character");
      return code;
    }));
    const response = new Response(encoded, { headers: { "content-type": "text/html; charset=windows-1255" } });
    const readers = await MaccabiReaders.create(new LegacyMock([login(), response]));
    const result = await readers.getMedicalRecommendations();
    expect(JSON.stringify(result.data)).toContain("שלום");
    expect(JSON.stringify(result.data)).not.toContain("�");
    for (const bad of [new Response(encoded, { headers: { "content-type": "text/html; charset=utf-8" } }), new Response(encoded, { headers: { "content-type": "text/html; charset=utf-16" } }), new Response(new Uint8Array(1024 * 1024 + 1), { headers: { "content-type": "text/html; charset=windows-1255" } })]) {
      const invalid = await MaccabiReaders.create(new LegacyMock([login(), bad]));
      await expect(invalid.getMedicalRecommendations()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });
  test("wrong owner/origin and expired login differ from transport failure and never yield empty records", async () => {
    const cases = [
      [html(recommendations.replace(String(profile.member_id), "999999999")), "OWNER_MISMATCH"],
      [html(recommendations, "https://example.invalid/online/medicalfile/personalrecommendations/"), "INVALID_RESPONSE"],
      [html(recommendations, "https://online.maccabi4u.co.il/my.logout.php3"), "REAUTHENTICATION_REQUIRED"],
      [html(`<script>window.originJWT = 'synthetic-login-token';</script>`), "REAUTHENTICATION_REQUIRED"],
      [new Response("Temporary transport page", { status: 502 }), "UPSTREAM_HTTP"],
    ] as const;
    for (const [response, code] of cases) {
      const readers = await MaccabiReaders.create(new LegacyMock([login(), response]));
      await expect(readers.getMedicalRecommendations()).rejects.toMatchObject({ code });
    }
  });
  test("hospital history proves owner before cookie-only retrieval and separates business failure from empty", async () => {
    const row = { NameHospital: "בית חולים לדוגמה", DateHospitalization: "source-date", Date: "source-date", DurationHospitalization: "original", QuantityTreatments: "original", TypeCommitment: "original", Department: "מקור", HasLink: true, LinkPDF: "private-link", TypeCommitmentEgenKey: "private-routing", DescriptionTreatment: [{ Description: "טיפול מקורי" }], DescriptionDistinction: [{ Description: "מקור" }] };
    const transport = new LegacyMock([login(), html(hospital), { ReportHospitalizations: [row], ResultMessage: { Code: 0 } }, html(hospital), { ReportHospitalizations: [], ResultMessage: { Code: 0 } }, html(hospital), { ReportHospitalizations: [], ResultMessage: { Code: 9 } }]);
    const readers = await MaccabiReaders.create(transport);
    const result = await readers.listHospitalHistory("2026-09-20");
    expect(JSON.parse(String(transport.calls[2]?.init?.body))).toEqual({ isDateSelected: false, fromDate: 20092023, toDate: 20092026 });
    expect(transport.calls[2]?.path).toBe("/online/webapi/MailingsFromHospitals/GetMailingsFromHospitals/");
    expect(transport.calls[2]?.init?.apiAuthorization).toBe(false);
    expect(result.data[0]?.DescriptionTreatment).toEqual([{ Description: "טיפול מקורי" }]);
    expect(JSON.stringify(result)).not.toMatch(/private|EgenKey|LinkPDF/);
    expect((await readers.listHospitalHistory("2026-09-20")).data).toEqual([]);
    await expect(readers.listHospitalHistory("2026-09-20")).rejects.toMatchObject({ code: "UPSTREAM_RESULT_ERROR" });
    const wrong = new LegacyMock([login(), html(hospital.replace(String(profile.member_id), "999999999"))]);
    await expect((await MaccabiReaders.create(wrong)).listHospitalHistory("2026-09-20")).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(wrong.calls).toHaveLength(2);
  });
  test("hospital date selection follows the source picker string format and page lookback bounds", async () => {
    const transport = new LegacyMock([login(), html(hospital), { ReportHospitalizations: [], ResultMessage: { Code: 0 } }]);
    const readers = await MaccabiReaders.create(transport);
    await readers.listHospitalHistory("2026-09-21", { from: "2025-01-02", to: "2026-03-04" });
    expect(JSON.parse(String(transport.calls[2]!.init?.body))).toEqual({ isDateSelected: true, fromDate: "02012025", toDate: "04032026" });
    for (const range of [{from:"2020-01-01",to:"2026-01-01"},{from:"2026-01-01",to:"2026-10-01"}]) {
      const t = new LegacyMock([login(), html(hospital)]);
      await expect((await MaccabiReaders.create(t)).listHospitalHistory("2026-09-21", range)).rejects.toMatchObject({code:"UNSUPPORTED_FLOW"});
      expect(t.calls).toHaveLength(2);
    }
  });
  test("hospital PDF uses cloned owner-list reference and fixed cookie-only popup; rejects duplicates and unknown refs", async () => {
    const row = { NameHospital: "synthetic", DateHospitalization: "date", Date: "date", DurationHospitalization: "source", QuantityTreatments: "source", TypeCommitment: "source", Department: "source", HasLink: true, LinkPDF: "private+path", TypeCommitmentEgenKey: "private/type", DescriptionTreatment: [], DescriptionDistinction: [] };
    const payload = { ReportHospitalizations: [row], ResultMessage: { Code: 0 } };
    const pdf = () => new Response("%PDF-synthetic", { headers: { "content-type": "application/pdf" } });
    const transport = new LegacyMock([login(), html(hospital), payload, pdf()]);
    const readers = await MaccabiReaders.create(transport);
    const list = await readers.listHospitalHistory("2026-09-20");
    const ref = list.data[0]!.reference as string;
    expect(ref).toMatch(/^[a-f0-9]{64}$/);
    list.data[0]!.reference = "changed-output";
    expect(new TextDecoder().decode((await readers.getHospitalReportPdf(ref, "2026-09-20")).data)).toBe("%PDF-synthetic");
    const url = new URL(transport.calls[3]!.path, "https://example.invalid");
    expect(url.pathname).toBe("/online/Pages/Popups/MailingsFromHospitals/MailingsFromHospitals.aspx");
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: "private+path", typeCommitment: "private/type" });
    expect(transport.calls[3]!.init?.apiAuthorization).toBe(false);
    await expect(readers.getHospitalReportPdf("0".repeat(64), "2026-09-20")).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(transport.calls).toHaveLength(4);
    const fresh = await MaccabiReaders.create(new LegacyMock([login(), html(hospital), payload, pdf()]));
    expect((await fresh.getHospitalReportPdf(ref, "2026-09-20")).data.byteLength).toBeGreaterThan(5);
    const duplicate = await MaccabiReaders.create(new LegacyMock([login(), html(hospital), { ...payload, ReportHospitalizations: [row, row] }]));
    await expect(duplicate.listHospitalHistory("2026-09-20")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const wrong = await MaccabiReaders.create(new LegacyMock([login(), html(hospital), payload, new Response("html", { headers: { "content-type": "text/html" } })]));
    await expect(wrong.getHospitalReportPdf(ref, "2026-09-20")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("owner contact profile and notification list", () => {
  test("contact profile uses owner bootstrap only and excludes payer/family/passport metadata", async () => {
    const owner = bootstrap();
    const address = { address_status: "source", address_type: "source", postal_code: "00000", city_name: "עיר לדוגמה", street_name: "רחוב לדוגמה", house_num: "1", entrance: "", apartment_num: "", zip_code: "00000", address_for_mail: "source", city_name_for_not_maccabi_member: "", street_name_for_not_maccabi_member: "", po_box: 0, token: "private" };
    Object.assign(owner.logged_customer_info, { email: "synthetic@example.invalid", phones_update_date: "original-date", phones: [{ phone_type: "source", phone_prefix: "000", phone_no: 12345, fax_special_prefix: "", extra: "private" }], addresses: [address], passport_number: "private", pays_phone: "private", unifier_email: "private" });
    const transport = new MockTransport([owner]);
    const result = (await MaccabiReaders.create(transport)).getOwnerContactProfile();
    expect(transport.calls).toHaveLength(1);
    expect(result.data.email).toBe("synthetic@example.invalid");
    expect(result.data.phones).toEqual([{ phone_type: "source", phone_prefix: "000", phone_no: 12345, fax_special_prefix: "" }]);
    expect(JSON.stringify(result)).not.toMatch(/private|passport|payer|unifier|member_id/);
  });
  test("notification letters bind request, member and recipient to owner; omit document signatures", async () => {
    const row = { member_id: profile.member_id, member_id_code: "0", recipient_id: profile.member_id, recipient_id_code: "0", child_info: false, letter_type: 1, letter_desc: "הודעה מקורית", item_date: "original-date", original_item_date: "original-date", mailing_type: "source", is_doc_exist: "source", hash: "private", timestamp: "private", reference_id: "private", recipient_f_name: "private" };
    const transport = new MockTransport([bootstrap(), { letters: [row] }]);
    const result = await (await MaccabiReaders.create(transport)).listNotifications({ from: "2025-01-01", to: "2026-01-01" });
    expect(JSON.parse(String(transport.calls[1]?.init?.body))).toEqual({ from_date: "2025-01-01", to_date: "2026-01-01", members: [{ member_id_code: "0", member_id: profile.member_id }] });
    expect(transport.calls[1]?.path.endsWith("/all/letters_for_member")).toBe(true);
    expect(result.data).toEqual([{ letter_type: 1, letter_desc: "הודעה מקורית", item_date: "original-date", original_item_date: "original-date" }]);
    for (const changed of [{ child_info: true }, { recipient_id: 999 }, { letter_type: 9 }]) {
      const readers = await MaccabiReaders.create(new MockTransport([bootstrap(), { letters: [{ ...row, ...changed }] }]));
      await expect(readers.listNotifications({ from: "2025-01-01", to: "2026-01-01" })).rejects.toMatchObject({ code: "letter_type" in changed ? "UNSUPPORTED_FLOW" : "OWNER_MISMATCH" });
    }
  });
});


describe("owner-bound vaccination dose expansion", () => {
  const group = { vaccine_group_code: 7, vaccinations_amount: 1, vaccine_group_name: "חיסון לדוגמה", first_date: "original", last_date: "original", timestamp: "private" };
  test("derives birth date and group from owner and preserves only original clinical dose fields", async () => {
    const transport = new MockTransport([bootstrap(), { timeline: [group] }, [{ vaccination_date: "original-date", vaccination_place: "מרפאה", age_on_vaccination: "גיל מקורי", remark: null, source: "2", virtual_key: "private", record_id: "private" }]]);
    const readers = await MaccabiReaders.create(transport);
    const result = await readers.getVaccinationDoses(7);
    const url = new URL(transport.calls[2]!.path, "https://example.invalid");
    expect(url.searchParams.get("birth_date")).toBe(profile.birth_date);
    expect(url.searchParams.get("vaccine_group_code")).toBe("7");
    expect(result.data).toEqual([{ vaccination_date: "original-date", vaccination_place: "מרפאה", age_on_vaccination: "גיל מקורי", remark: null, source: "2" }]);
    expect(result.source.schemaEvidence).toBe("frontend-field-projection");
  });
  test("rejects arbitrary references and changed dose schema without writes", async () => {
    const transport = new MockTransport([bootstrap(), { timeline: [group] }]);
    const readers = await MaccabiReaders.create(transport);
    await expect(readers.getVaccinationDoses(-1)).rejects.toThrow(TypeError);
    expect(transport.calls).toHaveLength(1);
    await expect(readers.getVaccinationDoses(99)).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(transport.calls).toHaveLength(2);
    const changed = await MaccabiReaders.create(new MockTransport([bootstrap(), { timeline: [group] }, [{ vaccination_date: "date", remark: { unknown: true } }]]));
    await expect(changed.getVaccinationDoses(7)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("source-complete original document reads", () => {
  const range = { from: "2025-01-01", to: "2026-01-01" };
  const pdf = () => new Response("%PDF-synthetic", { headers: { "content-type": "application/pdf" } });
  const prescription = { is_digital_prescription: true, purchase_status: 1, doc_id: "rx-fixture", drug_name: "מקור", drug_instructions: "מקור", from_date: "date", to_date: "date", timestamp: "time", hash: "a%2B%2F", file_link: "private+file/path", member_id: String(profile.member_id), member_id_code: 0 };
  test("prescription PDF uses a cloned unique owner-list row and encoded fixed query", async () => {
    const transport = new MockTransport([bootstrap(), { results: [prescription] }, pdf()]);
    const readers = await MaccabiReaders.create(transport);
    const list = await readers.listPrescriptions();
    expect(JSON.stringify(list)).not.toMatch(/private\+file|file_link|hash|timestamp/);
    list.data[0]!.file_link = "changed";
    expect((await readers.getPrescriptionPdf("rx-fixture")).data.byteLength).toBeGreaterThan(5);
    const url = new URL(transport.calls[2]!.path, "https://synthetic.invalid");
    expect(url.pathname.endsWith("/getprescriptionpdf")).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({ timestamp: "time", hash: "a+/", data: "rx-fixture", path: "private+file/path" });
    expect(transport.calls[2]!.init?.apiAuthorization).toBe(false);
    await expect(readers.getPrescriptionPdf("unknown")).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(transport.calls).toHaveLength(3);
    const ambiguous = await MaccabiReaders.create(new MockTransport([bootstrap(), { results: [prescription, prescription] }]));
    await expect(ambiguous.getPrescriptionPdf("rx-fixture")).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });
  test("prescription PDF enforces source digital and purchase-status print gate before download", async () => {
    for (const changed of [{ is_digital_prescription: false }, { purchase_status: 4 }, { purchase_status: 5 }, { purchase_status: 6 }, { purchase_status: "1" }]) {
      const transport = new MockTransport([bootstrap(), { results: [{ ...prescription, ...changed }] }]);
      const readers = await MaccabiReaders.create(transport);
      await expect(readers.getPrescriptionPdf("rx-fixture")).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW" });
      expect(transport.calls).toHaveLength(2);
    }
    for (const purchase_status of [2, 3]) {
      const readers = await MaccabiReaders.create(new MockTransport([bootstrap(), { results: [{ ...prescription, purchase_status }] }, pdf()]));
      expect((await readers.getPrescriptionPdf("rx-fixture")).data.byteLength).toBeGreaterThan(5);
    }
  });
  test("notification PDF retains no private routing fields and resolves same-range owner reference", async () => {
    const row = { member_id: profile.member_id, member_id_code: "0", recipient_id: profile.member_id, recipient_id_code: "0", child_info: false, letter_type: 1, letter_desc: "הודעה", item_date: "date", original_item_date: "date", reference_id: "private-ref", name_document: "private-name", hash: "a%2B%2F", timestamp: "time" };
    const transport = new MockTransport([bootstrap(), { letters: [row] }, pdf()]);
    const readers = await MaccabiReaders.create(transport);
    const list = await readers.listNotifications(range), ref = list.data[0]!.reference as string;
    expect(JSON.stringify(list)).not.toMatch(/private|hash|timestamp|member_id|recipient/);
    await readers.getNotificationPdf(ref, range);
    const url = new URL(transport.calls[2]!.path, "https://synthetic.invalid");
    expect(url.pathname.endsWith("/letters_for_member/private-ref/private-name/pdf")).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({ timestamp: "time", hash: "a+/" });
    expect(transport.calls[2]!.init?.apiAuthorization).toBe(false);
    const fresh = await MaccabiReaders.create(new MockTransport([bootstrap(), { letters: [row] }, pdf()]));
    expect((await fresh.getNotificationPdf(ref, range)).data.byteLength).toBeGreaterThan(5);
    const duplicate = await MaccabiReaders.create(new MockTransport([bootstrap(), { letters: [row, row] }]));
    await expect(duplicate.listNotifications(range)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  test("same-path PDF redirect with changed document query fails closed", async () => {
    const changed = pdf();
    Object.defineProperty(changed, "url", { value: "https://online.maccabi4u.co.il/sonline/MedicalFileAPI/webapi/mac/v1/members/0/123456789/getprescriptionpdf?data=other" });
    const readers = await MaccabiReaders.create(new MockTransport([bootstrap(), { results: [prescription] }, changed]));
    await expect(readers.getPrescriptionPdf("rx-fixture")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  test("sensitivity report consumes source base64 field without inventing an upstream type enum", async () => {
    const transport = new MockTransport([bootstrap(), { base64: btoa("%PDF-synthetic") }]);
    const readers = await MaccabiReaders.create(transport);
    expect(new TextDecoder().decode((await readers.getSensitivityPdf()).data)).toBe("%PDF-synthetic");
    expect(transport.calls[1]!.path.endsWith("/sensitivity/pdf")).toBe(true);
    for (const base64 of ["not-base64", btoa("not a PDF"), "JVBERi0=\n"]) {
      const invalid = await MaccabiReaders.create(new MockTransport([bootstrap(), { base64 }]));
      await expect(invalid.getSensitivityPdf()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });
  test("information PDF uses type1 only, hides URL and excludes rotating signatures from local reference", async () => {
    const row = { type_id: 1, url: "https://synthetic.invalid/private+file", session_datetime: "date", timestamp: "time", hash: "a+/" };
    const transport = new MockTransport([bootstrap(), { tutorials: [row] }, pdf()]);
    const readers = await MaccabiReaders.create(transport);
    const result = await readers.listAdditionalInformation(range), ref = result.data[0]!.reference as string;
    expect(JSON.stringify(result)).not.toMatch(/private|hash|timestamp|https/);
    await readers.getAdditionalInformationPdf(ref, range);
    const url = new URL(transport.calls[2]!.path, "https://synthetic.invalid");
    expect(url.pathname).toContain("/v2/members/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ url: row.url, timestamp: "time", hash: "a+/" });
    expect(transport.calls[2]!.init?.apiAuthorization).toBe(false);
    const fresh = await MaccabiReaders.create(new MockTransport([bootstrap(), { tutorials: [{ ...row, hash: "rotated", timestamp: "changed" }] }, pdf()]));
    expect((await fresh.getAdditionalInformationPdf(ref, range)).data.byteLength).toBeGreaterThan(5);
    const external = await MaccabiReaders.create(new MockTransport([bootstrap(), { tutorials: [{ ...row, type_id: 2 }] }]));
    await expect(external.getAdditionalInformationPdf(ref, range)).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });
  test("source-encoded information URL/signature decode once; malformed signature fails without PDF request", async () => {
    const row = { type_id: 1, url: "https%3A%2F%2Fsynthetic.invalid%2Fprivate%2Bfile", session_datetime: "date", timestamp: "time", hash: "a%2B%2F" };
    const transport = new MockTransport([bootstrap(), { tutorials: [row] }, pdf()]);
    const readers = await MaccabiReaders.create(transport);
    const reference = (await readers.listAdditionalInformation(range)).data[0]!.reference as string;
    await readers.getAdditionalInformationPdf(reference, range);
    const url = new URL(transport.calls[2]!.path, "https://synthetic.invalid");
    expect(url.searchParams.get("url")).toBe("https://synthetic.invalid/private+file");
    expect(url.searchParams.get("hash")).toBe("a+/");
    const malformed = new MockTransport([bootstrap(), { results: [{ ...prescription, hash: "%broken" }] }]);
    await expect((await MaccabiReaders.create(malformed)).getPrescriptionPdf("rx-fixture")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(malformed.calls).toHaveLength(2);
  });
  test("lab file PDF selects one owner-bound nested test and exposes only an attachment-presence flag", async () => {
    const summary = { request_id: "request", doc_id: "doc", type: "lab_result", execute_date: "date", result_date: "date", test_name: ["בדיקה"] };
    const row = { test_id: "test", test_desc: "בדיקה", result: 1, result_file: "private+file", time_stamp: "time", hash: "a%2B%2F", lab_date: "date" };
    const detail = { results: [{ group_name: "מקור", group_values: [row] }], execute_date: "date", is_partial: false, corona_hash: "private-corona-signature", corona_t: "private-corona-time" };
    const transport = new MockTransport([bootstrap(), { tests: [summary], categories: [] }, detail, pdf()]);
    const readers = await MaccabiReaders.create(transport);
    expect((await readers.getLabResultFilePdf({source:"result",requestId:"request",docId:"doc",testId:"test"})).data.byteLength).toBeGreaterThan(5);
    const url = new URL(transport.calls[3]!.path, "https://synthetic.invalid");
    expect(url.pathname).toBe("/sonline/TestResultsAPI/webapi/mac/pdf/showresult");
    expect(Object.fromEntries(url.searchParams)).toEqual({ data: "private+file", t: "time", hash: "a+/", testDes: "בדיקה", labDate: "date" });
    expect(transport.calls[3]!.init?.apiAuthorization).toBe(false);
    const visible = await MaccabiReaders.create(new MockTransport([bootstrap(), { tests: [summary], categories: [] }, detail]));
    const result = await visible.getLabResult("request", "doc");
    expect(result.data.results[0]!.group_values[0]!.has_result_file).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private\+file|private-corona|\"result_file\"|\"hash\"|time_stamp/);
    const duplicate = await MaccabiReaders.create(new MockTransport([bootstrap(), { tests: [summary], categories: [] }, { ...detail, results: [{ group_name: "מקור", group_values: [row, row] }] }]));
    await expect(duplicate.getLabResultFilePdf({source:"result",requestId:"request",docId:"doc",testId:"test"})).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    const missing = await MaccabiReaders.create(new MockTransport([bootstrap(), { tests: [summary], categories: [] }, { ...detail, results: [{ group_name: "מקור", group_values: [{ ...row, result_file: "" }] }] }]));
    await expect(missing.getLabResultFilePdf({source:"result",requestId:"request",docId:"doc",testId:"test"})).rejects.toMatchObject({ code: "UNSUPPORTED_FLOW" });
  });
  test("the issue link rides only on the read failures that mean a defect in this client", () => {
    const ours: ReadErrorCode[] = ["INVALID_RESPONSE", "UNSUPPORTED_FLOW", "NOT_ELIGIBLE"];
    // A stale reference, a selected dependent, a missing token or a failing portal are not this
    // project's bugs. Asking for an issue there would teach a caller to skip the line everywhere.
    const notOurs: ReadErrorCode[] = ["UPSTREAM_HTTP", "UPSTREAM_RESULT_ERROR", "TOKEN_UNAVAILABLE", "OWNER_MISMATCH", "DEPENDENT_SELECTED"];
    expect([...ours, ...notOurs].sort()).toEqual(Object.keys(READ_ERROR_GUIDANCE).sort());
    for (const code of ours) expect(READ_ERROR_GUIDANCE[code]("labs")).toContain(ISSUES_URL);
    for (const code of notOurs) expect(READ_ERROR_GUIDANCE[code]("labs")).not.toContain(ISSUES_URL);
    // A library prints nothing, so the error object itself has to carry the guidance a caller acts on.
    expect(new ReadOperationError("INVALID_RESPONSE", "labs").guidance).toBe(READ_ERROR_GUIDANCE.INVALID_RESPONSE("labs"));
    expect(new ReadOperationError("INVALID_RESPONSE", "labs").guidance).toContain(ISSUES_URL);
    expect(new ReadOperationError("OWNER_MISMATCH", "labs").guidance).not.toContain(ISSUES_URL);
  });
});
