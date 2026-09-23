import { describe, expect, test } from "vitest";
import { MaccabiDirectory, isDoctorSpecialtyField } from "../src/directory";
import type { FetchFunction } from "../src/transport";

const entry = "https://serguide.maccabi4u.co.il/heb/doctors/";
const search = "https://serguide.maccabi4u.co.il/webapi/api/SearchPage/GetSearchPageSearch/";
function page(fields: unknown[] = [{ K: "101", V: "Synthetic specialty" }]) {
  return `<html><script>window.__INITIAL_STATE__ = ${JSON.stringify({ settings: { doctors: { Settings: { category: "Doctors_001" }, Data: { Fields: fields, Cities: [{ K: "42", V: "Synthetic city" }] } } } })}; window.doNotRun = () => { throw new Error('must not execute') };</script></html>`;
}
const doctor = {
  CHAPTER_CODE: "001", EmployeeNumber: 123, PositionId: 456, TITEL: "Synthetic title", FIRST_NAME: "Synthetic", LAST_NAME: "Provider", SERVICE_NAME: "",
  TREAT_AREA_1: "Specialty", TREAT_AREA_2: "", TREAT_AREA_3: "", TREAT_AREA_4: "", TREAT_AREA_5: "", TREAT_AREA_6: "",
  CITY_NAME: "Synthetic city", PARTIALLY_ADRESS: "Synthetic address", PHONENUMBERS: [{ Title: "Clinic", Value: "000-0000000", Type: 1, privateExtra: "omit-contact" }],
  ItemKeyIndex: "opaque-not-needed", ZIMUNLINK: "https://invalid.example/secret", hash: "omit-signature",
};
const result = () => ({ Success: true, Errors: [], Items: [{ ...doctor }], NumOfPages: 4, TotalItems: 33, SelectedTab: "1" });
function response(body: string, type = "text/html") { return new Response(body, { headers: { "Content-Type": type } }); }
function harness(html = page(), data: unknown = result()) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    return url === entry ? response(html) : response(JSON.stringify(data), "application/json");
  };
  return { client: new MaccabiDirectory({ fetch }), calls };
}

describe("anonymous public doctor directory", () => {
  test("discovers catalog then searches one exact specialty with fixed initial request and private-field projection", async () => {
    const { client, calls } = harness();
    const catalog = await client.listProviderFields("doctors");
    expect(catalog.data).toEqual([{ field: "101", label: "Synthetic specialty" }]);
    catalog.data[0].field = "mutated";
    const output = await client.searchProviders("doctors", "101");
    expect(calls.map(c => c.url)).toEqual([entry, entry, search]);
    for (const call of calls) {
      expect(call.init?.credentials).toBe("omit"); expect(call.init?.redirect).toBe("manual");
      const headers = new Headers(call.init?.headers);
      expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
    }
    const payload = JSON.parse(String(calls[2].init?.body));
    expect(payload).toEqual({ Field: "101", ChapterId: "001", InitiatorCode: "001", isKosher: 0, IsMobileApplication: 0, PageNumber: 1, RequestId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(output.data.coverage).toEqual({ page: 1, returned: 1, reportedTotalItems: 33, reportedTotalPages: 4, pagingSupported: true });
    expect(output.data.providers[0].PHONENUMBERS).toEqual([{ Title: "Clinic", Value: "000-0000000" }]);
    expect(output.data.providers[0].TREAT_AREA_1).toBe("Specialty");
    expect(JSON.stringify(output)).not.toMatch(/omit-|opaque-not-needed|invalid\.example/);
    expect(output.source.service).toBe("PublicDirectory");
  });

  test("public city catalog and source-bound name/city filters preserve display text", async () => {
    const { client, calls } = harness();
    expect((await client.listProviderCities("doctors")).data).toEqual([{ city: "42", label: "Synthetic city" }]);
    const output = await client.searchProviders("doctors", "101", { city: "42", name: "Synthetic Provider" });
    expect(output.data.filters).toEqual({ city: { city: "42", label: "Synthetic city" }, name: "Synthetic Provider" });
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({ City: "42", DocName: "Synthetic Provider", PageNumber: 1 });
  });

  test("requested page reuses the first search context and selected tab without crawling intermediate pages", async () => {
    const { client, calls } = harness();
    const output = await client.searchProviders("doctors", "101", { city: "42", page: 3 });
    expect(calls.map(call => call.url)).toEqual([entry, search, search]);
    const initial = JSON.parse(String(calls[1].init?.body));
    const next = JSON.parse(String(calls[2].init?.body));
    expect(next).toEqual({ ...initial, PageNumber: 3, Source: "SearchPage", ModuleName: "doctorssearchresults" });
    expect(output.data.coverage).toEqual({ page: 3, returned: 1, reportedTotalItems: 33, reportedTotalPages: 4, pagingSupported: true });
    for (const call of calls) {
      expect(call.init?.credentials).toBe("omit");
      expect(new Headers(call.init?.headers).has("cookie")).toBe(false);
      expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
    }
  });

  test("invalid filters/pages stop before search; out-of-range page stops after first result", async () => {
    for (const options of [{ page: 0 }, { page: 1001 }, { page: 1.5 }, { city: "42,43" }, { name: "" }, { name: "x\n" }]) {
      const { client, calls } = harness();
      await expect(client.searchProviders("doctors", "101", options)).rejects.toHaveProperty("code");
      expect(calls).toHaveLength(0);
    }
    const unknown = harness();
    await expect(unknown.client.searchProviders("doctors", "101", { city: "missing" })).rejects.toMatchObject({ code: "DIRECTORY_UNKNOWN_CITY" });
    expect(unknown.calls).toHaveLength(1);
    const out = harness();
    await expect(out.client.searchProviders("doctors", "101", { page: 5 })).rejects.toMatchObject({ code: "DIRECTORY_PAGE_OUT_OF_RANGE" });
    expect(out.calls).toHaveLength(2);
  });

  test("paged response cannot silently change tabs, shrink below requested page, or return a challenge", async () => {
    for (const next of [JSON.stringify({ ...result(), SelectedTab: "2" }), JSON.stringify({ ...result(), NumOfPages: 1 }), "<html>challenge</html>"]) {
      let posts = 0;
      const client = new MaccabiDirectory({ fetch: async url => {
        if (String(url) === entry) return response(page());
        posts++;
        return response(posts === 1 ? JSON.stringify(result()) : next, next.startsWith("<") && posts > 1 ? "text/html" : "application/json");
      } });
      await expect(client.searchProviders("doctors", "101", { page: 2 })).rejects.toMatchObject({ code: "DIRECTORY_INVALID_RESPONSE" });
      expect(posts).toBe(2);
    }
  });

  test("invalid field stops before fetching; unknown catalog member stops before POST", async () => {
    const { client, calls } = harness();
    for (const field of ["", "101,102", "101 102", "a".repeat(129)]) {
      expect(isDoctorSpecialtyField(field)).toBe(false);
      await expect(client.searchProviders("doctors", field)).rejects.toMatchObject({ code: "DIRECTORY_INVALID_FIELD" });
    }
    expect(calls).toHaveLength(0);
    await expect(client.searchProviders("doctors", "unknown")).rejects.toMatchObject({ code: "DIRECTORY_UNKNOWN_FIELD" });
    expect(calls).toHaveLength(1);
  });

  test("requires unique catalog configuration and never evaluates scripts", async () => {
    for (const html of [page() + page(), page([{ K: "101", V: "A" }, { K: "101", V: "B" }]), page().replace('Doctors_001','Other_002'), page().replace('}; window.doNotRun', '}; __INITIAL_STATE__ = {}; window.doNotRun')]) {
      const { client, calls } = harness(html);
      await expect(client.searchProviders("doctors", "101")).rejects.toMatchObject({ code: "DIRECTORY_INVALID_RESPONSE" });
      expect(calls).toHaveLength(1);
    }
    const tricky = harness(page([{ K: "101", V: 'Synthetic }; { " bracket label' }]));
    expect((await tricky.client.listProviderFields("doctors")).data[0].label).toBe('Synthetic }; { " bracket label');
  });

  test("missing public configuration is distinct and stops before a search POST", async () => {
    const { client, calls } = harness("<html><body>Public directory</body><script>window.unrelated = {};</script></html>");
    await expect(client.searchProviders("doctors", "101")).rejects.toMatchObject({
      code: "DIRECTORY_CONFIGURATION_UNAVAILABLE",
      message: "The public site did not supply the expected search configuration. Check the official doctor directory in your browser; no search was submitted.",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.credentials).toBe("omit");
    expect(new Headers(calls[0].init?.headers).has("cookie")).toBe(false);
    expect(new Headers(calls[0].init?.headers).has("authorization")).toBe(false);
  });

  test("empty success is explicit; bad results never become empty success or raw error output", async () => {
    expect((await harness(page(), { ...result(), Items: [], NumOfPages: 0, TotalItems: 0 }).client.searchProviders("doctors", "101")).data.providers).toEqual([]);
    for (const data of [
      { ...result(), Success: false, Errors: ["untrusted secret"] },
      { ...result(), Items: [{ ...doctor, CHAPTER_CODE: "002" }] },
      { ...result(), Items: [{ ...doctor, CITY_NAME: {} }] },
      { ...result(), TotalItems: -1 }, { ...result(), TotalItems: 0 },
      { ...result(), Items: Array.from({ length: 101 }, () => doctor), TotalItems: 101 },
    ]) {
      try { await harness(page(), data).client.searchProviders("doctors", "101"); throw new Error("unexpected success"); }
      catch (error) { expect(error).toHaveProperty("code"); expect(String(error)).not.toContain("untrusted secret"); }
    }
  });

  test("redirects, unexpected destinations, wrong MIME and oversized or malformed UTF8 stop safely without following", async () => {
    const redirected = response(page()); Object.defineProperty(redirected, "url", { value: "https://invalid.example/secret" });
    const cases = [new Response(null, { status: 302, headers: { Location: "https://invalid.example" } }), redirected, response(page(), "application/json"), response("x".repeat(4 * 1024 * 1024 + 1)), new Response(new Uint8Array([255]), { headers: { "Content-Type": "text/html" } })];
    for (const value of cases) {
      let calls = 0;
      const client = new MaccabiDirectory({ fetch: async () => { calls++; return value; } });
      await expect(client.listProviderFields("doctors")).rejects.toHaveProperty("code");
      expect(calls).toBe(1);
    }
  });

  test("network and stalled-body failures retain safe timeout/cancellation codes", async () => {
    for (const [name, code] of [["TimeoutError", "REQUEST_TIMEOUT"], ["AbortError", "REQUEST_ABORTED"], ["Error", "DIRECTORY_REQUEST_FAILED"]]) {
      const client = new MaccabiDirectory({ fetch: async () => { const error = new Error("secret network data"); error.name = name; throw error; } });
      await expect(client.listProviderFields("doctors")).rejects.toMatchObject({ code });
    }
    const client = new MaccabiDirectory({ fetch: async () => new Response(new ReadableStream({ start(controller) { const error = new Error("secret body"); error.name = "TimeoutError"; controller.error(error); } }), { headers: { "Content-Type": "text/html" } }) });
    await expect(client.listProviderFields("doctors")).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });
});

const details = "https://serguide.maccabi4u.co.il/webapi/api/ProviderDetails/";
const settings = "https://serguide.maccabi4u.co.il/webapi/api/SettingsForSearch/GetSettingsForSearch/";
function detailFixture(lab = false): Record<string, unknown> {
  const row: Record<string, unknown> = {
    Success: true, ErrorCode: 0, Chapter_Code: lab ? "003" : "001", PositionId: "000456", Pernr: lab ? "" : "000123",
    Languages: ["Synthetic language"], Treat_Areas: [{ TreatCode: "1", TreatArea: "Synthetic field" }],
    ContactDetails: [{ Type: 1, Title: "Clinic", Value: "000-0000000", Code: "1", IsDirectContact: false, privateExtra: "omit-contact" }],
    Schedules: [{ Schedule_Type: "1", Schedule_Desc: "Synthetic hours", Schedule_Details: [{ Week_Day: "1", Week_Day_Eng: null, Week_Day_S: "Su", Week_Day_L: "Sunday", Shift_Start_H: "09:00", Shift_End_H: "12:00", Frequency_Desc: "Weekly", Remark_Desc: "Synthetic hours note" }] }],
    ResumeLines: [], Treatments: [], NameRemarks: [], ContactRemarks: [], DirectionRemarks: [], GeneralRemarks: [], NoticeRemarks: [], ProfessionRemarks: [],
    BoldComments: [{ Remark_Text: "Original public remark", Line_Number: "1", NewLine: true, Mlh: "", URL: "https://invalid.example/omit-link" }],
    ZIMUNLINK: "omit-booking", DeepLink: "omit-deeplink", ItemKeyIndex: "omit-routing",
  };
  for (const key of ["Titel", "First_Name", "Last_Name", "Service_Name", "Full_Adress", "City_Name", "Street_Name", "House_Number", "Neighborhood", "Posta", "Relevnt_Populat", "Referring_Text", "Access", "Age_Range_From", "Age_Range_To", "Treat_Area_String"]) row[key] = "";
  row.City_Name = doctor.CITY_NAME;
  return row;
}
function detailHarness(options: { lab?: boolean; changeDetail?: (value: Record<string, unknown>) => void; missing?: boolean; challenge?: boolean } = {}) {
  const calls: { url: string; body: Record<string, unknown> | undefined; init?: RequestInit }[] = [];
  let searches = 0;
  const client = new MaccabiDirectory({ fetch: async (url, init) => {
    const key = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: key, body, init });
    if (key === entry) return response(page());
    if (key === settings) return response(JSON.stringify({ Settings: { category: "LabsAndTherapists_003" }, Data: { Fields: [{ K: "101", V: "Synthetic service" }], Cities: [{ K: "42", V: "Synthetic city" }] } }), "application/json");
    if (key === search) {
      searches++;
      const item = { ...doctor, CHAPTER_CODE: options.lab ? "003" : "001", EmployeeNumber: options.lab ? 0 : 123, ItemKeyIndex: `fresh-opaque-${searches}` };
      return response(JSON.stringify({ ...result(), SelectedTab: options.lab ? null : "1", Items: options.missing ? [] : [item] }), "application/json");
    }
    if (key === details) {
      if (options.challenge) return response("<html>Challenge</html>");
      const value = detailFixture(options.lab); options.changeDetail?.(value);
      return response(JSON.stringify(value), "application/json");
    }
    throw new Error("Unexpected synthetic request");
  } });
  return { client, calls };
}

describe("public provider categories and independently bound details", () => {
  test("page2 filtered reference survives a new client and rotating route keys; detail uses the newly selected result", async () => {
    const first = detailHarness();
    const searched = await first.client.searchProviders("doctors", "101", { city: "42", name: "Synthetic", page: 2 });
    expect(searched.data.selection).toEqual({ category: "doctors", field: "101", options: { city: "42", name: "Synthetic", page: 2 } });
    const reference = searched.data.providers[0].reference;
    const second = detailHarness();
    const { category, field, options } = searched.data.selection;
    const detail = await second.client.getProviderDetails(category, field, reference, options);
    expect(second.calls.map(call => call.url)).toEqual([entry, search, search, details]);
    const freshSearch = second.calls[2].body!;
    expect(freshSearch).toMatchObject({ PageNumber: 2, City: "42", DocName: "Synthetic", Source: "SearchPage", ModuleName: "doctorssearchresults" });
    expect(freshSearch.RequestId).not.toEqual(first.calls[2].body!.RequestId);
    expect(second.calls[3].body).toEqual({ ItemKeyIndex: "fresh-opaque-2", Source: "SearchPageResults", RequestId: freshSearch.RequestId, ChapterId: "001", InitiatorCode: "001", IsKosher: 0, IsMobileApplication: 0 });
    expect(detail.data.reference).toBe(reference);
    expect(detail.data.Schedules[0].Schedule_Details[0].Remark_Desc).toBe("Synthetic hours note");
    expect(detail.data.Schedules[0].Schedule_Details[0].Week_Day_Eng).toBeNull();
    expect(detail.data.remarks.BoldComments[0].Remark_Text).toBe("Original public remark");
    expect(JSON.stringify(detail)).not.toMatch(/omit-|fresh-opaque/);
    for (const { init } of second.calls) {
      expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).has("cookie")).toBe(false); expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
  });
  test("labs category uses its captured settings and chapter, preserves shared display fields and validates facility identity", async () => {
    const { client, calls } = detailHarness({ lab: true });
    expect((await client.listProviderFields("labs-and-therapists")).data).toEqual([{ field: "101", label: "Synthetic service" }]);
    expect(calls[0].body).toEqual({ ModuleName: "labsandtherapists", initiatorCode: "001" });
    expect((await client.listProviderCities("labs-and-therapists")).data).toEqual([{ city: "42", label: "Synthetic city" }]);
    const searched = await client.searchProviders("labs-and-therapists", "101");
    expect(calls.at(-1)?.body).toMatchObject({ ChapterId: "003", PageNumber: 1 });
    expect((await client.getProviderDetails("labs-and-therapists", "101", searched.data.providers[0].reference)).data.ContactDetails).toHaveLength(1);
    expect(calls.at(-1)?.body).toMatchObject({ ChapterId: "003", IsKosher: 0 });
    expect((await client.searchProviders("labs-and-therapists", "101", { page: 2 })).data.coverage.page).toBe(2);
    expect(calls.at(-1)?.body).toMatchObject({ ChapterId: "003", PageNumber: 2, ModuleName: "labsandtherapistssearchresults" });
    expect(calls.at(-1)?.body).not.toHaveProperty("SelectedTab");
  });
  test("unknown categories/references fail before requests; disappearing or different-category references cannot issue a detail request", async () => {
    const { client, calls } = detailHarness();
    await expect(client.listProviderFields("other" as "doctors")).rejects.toMatchObject({ code: "DIRECTORY_INVALID_CATEGORY" });
    await expect(client.getProviderDetails("doctors", "101", "https://invalid.example")).rejects.toMatchObject({ code: "DIRECTORY_INVALID_REFERENCE" });
    expect(calls).toHaveLength(0);
    const found = await client.searchProviders("doctors", "101");
    const missing = detailHarness({ missing: true });
    await expect(missing.client.getProviderDetails("doctors", "101", found.data.providers[0].reference)).rejects.toMatchObject({ code: "DIRECTORY_REFERENCE_NOT_FOUND" });
    expect(missing.calls.map(call => call.url)).toEqual([entry, search]);
    const labs = detailHarness({ lab: true });
    await expect(labs.client.getProviderDetails("labs-and-therapists", "101", found.data.providers[0].reference)).rejects.toMatchObject({ code: "DIRECTORY_REFERENCE_NOT_FOUND" });
    expect(labs.calls.map(call => call.url)).toEqual([settings, search]);
  });
  test("wrong chapter, identity, failure state, bad nested fields and oversized display values fail closed", async () => {
    const found = await detailHarness().client.searchProviders("doctors", "101");
    for (const changeDetail of [
      (v: Record<string, unknown>) => { v.PositionId = "999"; },
      (v: Record<string, unknown>) => { v.Pernr = "999"; },
      (v: Record<string, unknown>) => { v.Chapter_Code = "003"; },
      (v: Record<string, unknown>) => { v.Service_Name = "Other"; },
      (v: Record<string, unknown>) => { v.Success = false; },
      (v: Record<string, unknown>) => { v.Schedules = [{}]; },
      (v: Record<string, unknown>) => { v.ContactDetails = [{ Type: "1" }]; },
      (v: Record<string, unknown>) => { v.Full_Adress = "x".repeat(16_385); },
    ]) {
      const { client } = detailHarness({ changeDetail });
      await expect(client.getProviderDetails("doctors", "101", found.data.providers[0].reference)).rejects.toHaveProperty("code");
    }
    const challenged = detailHarness({ challenge: true });
    await expect(challenged.client.getProviderDetails("doctors", "101", found.data.providers[0].reference)).rejects.toMatchObject({ code: "DIRECTORY_INVALID_RESPONSE" });
    expect(challenged.calls).toHaveLength(3);
  });
});

test("a paged labs response cannot change the captured null tab context", async () => {
  let calls = 0;
  const client = new MaccabiDirectory({ fetch: async (url) => {
    calls++;
    if (String(url) === settings) return response(JSON.stringify({ Settings: { category: "LabsAndTherapists_003" }, Data: { Fields: [{ K: "101", V: "Synthetic service" }], Cities: [{ K: "42", V: "Synthetic city" }] } }), "application/json");
    return response(JSON.stringify({ ...result(), SelectedTab: calls === 2 ? null : "1" }), "application/json");
  } });
  await expect(client.searchProviders("labs-and-therapists", "101", { page: 2 })).rejects.toMatchObject({ code: "DIRECTORY_INVALID_RESPONSE" });
  expect(calls).toBe(3);
});
