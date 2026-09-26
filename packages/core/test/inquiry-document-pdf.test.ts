import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { MaccabiReaders, type ReadTransport } from "../src/readers";

const owner = { member_id: 123456789, member_id_code: "0", f_name_hebrew: "דוגמה", l_name_hebrew: "בדיקה", f_name_english: "Example", l_name_english: "Fixture", birth_date: "2000-01-01", sex: "synthetic" };
const bootstrap = () => ({ logged_customer_info: owner, current_customer_info: owner, token: { content: "synthetic-token", success: true } });
const inquiry = () => ({ ...owner, request_id: "314", type: "medical_form_request", service_provider_name: "דוגמה", request_status: "מקור", status_update_date: "source-date" });
const detail = () => ({ request_id: 314, user_id: owner.member_id, user_code: "0", patient_remark: "טקסט מקור", doctor_remark: "מקור", creation_date: "source-date", update_date: "source-date", doctor_name: "דוגמה", request_status_desc: "מקור", prescription_largo_code_list: [], approval_request_details: [], prescription_user_drugs_indication: [], medical_forms_details: [], open_medical_record_number: "synthetic-associated-visit" });
const referral = () => ({ referral_id: "synthetic-referral", referral_displaying_name: "הפניה סינתטית", referral_pdf_link: "/synthetic/referral a.pdf", timestamp: "row-time", hash: "row%2Bhash" });
const visit = () => ({ member_id: owner.member_id, member_id_code: "0", visit_summary_date: "source-date", visit_summary_pdf_link: "/synthetic/not-selected.pdf", timestamp: "parent-time", hash: "parent-hash", referrals: [referral()] });
const pdf = () => new Response("%PDF-1.7 synthetic original referral", { headers: { "content-type": "application/pdf" } });
class MockTransport implements ReadTransport {
  calls: { path: string; init?: RequestInit & { apiAuthorization?: boolean } }[] = [];
  constructor(private responses: unknown[]) {}
  setApiToken(_token: string) {}
  async request(input: string | URL, init?: RequestInit & { apiAuthorization?: boolean }) {
    this.calls.push({ path: String(input), init });
    const next = this.responses.shift();
    return next instanceof Response ? next : Response.json(next);
  }
}
const reference = (path = referral().referral_pdf_link, index = 0) => createHash("sha256").update(JSON.stringify(["inquiry:314", "referrals", index, path])).digest("hex");
const sourceResponses = () => [{ inquiries: [inquiry()] }, detail(), visit()];

describe("inquiry-associated referral PDF", () => {
  test("fresh owner binding selects the same referral row's private path and signatures, preserving bytes", async () => {
    const transport = new MockTransport([bootstrap(), ...sourceResponses(), ...sourceResponses(), pdf()]);
    const readers = await MaccabiReaders.create(transport);
    const visible = await readers.getInquiry("314");
    expect(JSON.stringify(visible)).not.toMatch(/referral_pdf_link|row-time|row%2Bhash|parent-hash|synthetic-associated-visit/);
    const summary = visible.data.visit_summary as { data: { referrals: Record<string, unknown>[] } };
    summary.data.referrals[0]!.referral_pdf_link = "/caller-injected";
    summary.data.referrals[0]!.hash = "caller-injected";
    const result = await readers.getInquiryDocumentPdf("314", reference());
    expect(new TextDecoder().decode(result.data)).toBe("%PDF-1.7 synthetic original referral");
    expect(result.source).toMatchObject({ service: "AppointmentOrderAPI", operation: "inquiry-document-pdf" });
    expect(transport.calls.slice(4, 7).map(call => new URL(call.path, "https://online.maccabi4u.co.il").pathname.split("/").slice(-2).join("/"))).toEqual(["123456789/inquiries", "314/details", "synthetic-associated-visit/"]);
    const selected = transport.calls.at(-1)!;
    const url = new URL(selected.path, "https://online.maccabi4u.co.il");
    expect(url.pathname).toBe("/sonline/AppointmentOrderAPI/webapi/mac/v1/members/0/123456789/pdf");
    expect(url.search).toBe("?path=%2Fsynthetic%2Freferral%20a.pdf&timestamp=row-time&hash=row%2Bhash");
    expect(selected.init?.apiAuthorization).toBe(false);
    expect(transport.calls.every(call => !call.init?.method || call.init.method === "GET")).toBe(true);
  });

  test("unknown referral membership and absent PDF stop before download", async () => {
    const cases = [
      { referrals: [], id: "synthetic-referral", code: "OWNER_MISMATCH" },
      { referrals: [referral()], id: "not-listed", code: "OWNER_MISMATCH" },
      { referrals: [{ ...referral(), referral_pdf_link: "" }], id: "synthetic-referral", code: "OWNER_MISMATCH" },
      { referrals: [{ ...referral(), hash: "unsafe&extra=value" }], id: "synthetic-referral", code: "INVALID_RESPONSE" },
    ];
    for (const item of cases) {
      const transport = new MockTransport([bootstrap(), { inquiries: [inquiry()] }, detail(), { ...visit(), referrals: item.referrals }]);
      await expect((await MaccabiReaders.create(transport)).getInquiryDocumentPdf("314", item.id === "not-listed" ? "a".repeat(64) : reference())).rejects.toMatchObject({ code: item.code });
      expect(transport.calls).toHaveLength(4);
    }
  });

  test("wrong inquiry, associated owner, or nested owner cannot reach the PDF route", async () => {
    const cases = [
      [{ inquiries: [inquiry()] }, { ...detail(), user_id: 999 }, visit()],
      [{ inquiries: [inquiry()] }, detail(), { ...visit(), member_id: 999 }],
      [{ inquiries: [inquiry()] }, detail(), { ...visit(), referrals: [{ ...referral(), member_id: 999 }] }],
    ];
    for (const responses of cases) {
      const transport = new MockTransport([bootstrap(), ...responses]);
      await expect((await MaccabiReaders.create(transport)).getInquiryDocumentPdf("314", reference())).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
      expect(transport.calls.some(call => call.path.includes("/pdf?"))).toBe(false);
    }
    const missing = new MockTransport([bootstrap(), { inquiries: [inquiry()] }, { ...detail(), open_medical_record_number: null }]);
    await expect((await MaccabiReaders.create(missing)).getInquiryDocumentPdf("314", reference())).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(missing.calls).toHaveLength(3);
    const unsupported = new MockTransport([bootstrap(), { inquiries: [{ ...inquiry(), type: "automatic_sick_permit", medical_forms_documents: [] }] }]);
    await expect((await MaccabiReaders.create(unsupported)).getInquiryDocumentPdf("314", reference())).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(unsupported.calls).toHaveLength(2);
    const unlisted = new MockTransport([bootstrap(), { inquiries: [inquiry()] }]);
    await expect((await MaccabiReaders.create(unlisted)).getInquiryDocumentPdf("315", reference())).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(unlisted.calls).toHaveLength(2);
  });

  test("fresh details cannot reuse a formerly eligible associated referral", async () => {
    const transport = new MockTransport([bootstrap(), ...sourceResponses(), { inquiries: [inquiry()] }, { ...detail(), open_medical_record_number: null }]);
    const readers = await MaccabiReaders.create(transport);
    await readers.getInquiry("314");
    await expect(readers.getInquiryDocumentPdf("314", reference())).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(transport.calls.some(call => call.path.includes("/pdf?"))).toBe(false);
  });

  test("shared exact-response and two-MiB gates reject changed routing, non-PDF and oversized bodies", async () => {
    const changed = pdf();
    Object.defineProperty(changed, "url", { value: "https://online.maccabi4u.co.il/sonline/AppointmentOrderAPI/webapi/mac/v1/members/0/123456789/pdf?path=changed" });
    for (const response of [changed, new Response("%PDF-synthetic", { headers: { "content-type": "text/html" } }), new Response("not PDF", { headers: { "content-type": "application/pdf" } }), new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/pdf" } })]) {
      const transport = new MockTransport([bootstrap(), ...sourceResponses(), response]);
      await expect((await MaccabiReaders.create(transport)).getInquiryDocumentPdf("314", reference())).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
      expect(transport.calls).toHaveLength(5);
    }
  });
});

test("all five answered form categories preserve the patient request and source PDF gate",async()=>{
  for (const form_type of [1,2,3,4,5]) {
    const row={form_type,document_id:"synthetic-document",valid_from:"2024-01-01",valid_until:"2025-01-01",link_pdf:"/synthetic/form.pdf",timestamp:"time",hash:"escaped%2Bhash"};
    const data={...detail(),open_medical_record_number:null,prescription_largo_code_list:[{drug_name:"Synthetic requested medicine",private:"omit"}],approval_request_details:[{approval_required_from:"2024-01-01",approval_required_to:"2024-01-02",approval_additional_text:"Original request"}],prescription_user_drugs_indication:[{private:"edit-only"}],medical_forms_details:[row]};
    const source=[{inquiries:[{...inquiry(),type:"source-expandable",request_status_code:"1"}]},data];
    const t=new MockTransport([bootstrap(),...source,...source,pdf()]);
    const reader=await MaccabiReaders.create(t), visible=await reader.getInquiry("314");
    expect(visible.data).toMatchObject({patient_remark:"טקסט מקור",doctor_remark:"מקור",prescription_largo_code_list:[{drug_name:"Synthetic requested medicine"}],approval_request_details:[{approval_additional_text:"Original request"}],unsupported_sections:["prescription_user_drugs_indication"]});
    const ref=(visible.data.medical_forms_details as Record<string,unknown>[])[0]!.pdf_reference as string;
    expect(ref).toMatch(/^[a-f0-9]{64}$/);
    await reader.getInquiryDocumentPdf("314",ref);
    expect(t.calls.at(-1)!.path).toContain("/AppointmentOrderAPI/webapi/mac/v1/");
    expect(JSON.stringify(visible)).not.toMatch(/escaped%2Bhash|link_pdf|edit-only/);
  }
});

test("associated visit exposes original notes and every eligible document without private routing",async()=>{
  const rows={drugs:[{drug_name:"Synthetic medicine",prescription_is_digital:1,rescription_cancellation_status:0,prescription_pdf_link:"drug.pdf",timestamp:"time",hash:"hash"}],referrals:[referral()],approvals:[{approval_name:"Synthetic approval",approval_pdf_link:"approval.pdf",timestamp:"time",hash:"hash"}],tutorials:[{item_title:"Synthetic information",type_id:1,item_url:"info.pdf",timestamp:"time",hash:"hash"}]};
  const expanded={...visit(),...rows,visit_recommendations:"Original recommendations",follow_up_details:"Original follow-up",diagnosis:[{diagnosis_description:"Original diagnosis"}]};
  for(const collection of ["drugs","referrals","approvals","tutorials","summary"]){
    const source=[{inquiries:[inquiry()]},detail(),expanded];
    const t=new MockTransport([bootstrap(),...source,...source,pdf()]),reader=await MaccabiReaders.create(t);
    const output=await reader.getInquiry("314"),data=(output.data.visit_summary as {data:Record<string,unknown>}).data;
    expect(data).toMatchObject({visit_recommendations:"Original recommendations",follow_up_details:"Original follow-up",diagnosis:[{diagnosis_description:"Original diagnosis"}]});
    const ref=collection==="summary"?data.summary_pdf_reference:(data[collection] as Record<string,unknown>[])[0]!.pdf_reference;
    expect(ref).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(output)).not.toMatch(/pdf_link|item_url|"hash"|"timestamp"|row-time|parent-hash/);
    await reader.getInquiryDocumentPdf("314",ref as string);
    expect(t.calls.at(-1)!.path).toContain(collection==="tutorials"?"/MedicalFileAPI/webapi/mac/v2/":"/AppointmentOrderAPI/webapi/mac/v1/");
  }
});

test("automatic listed PDF refreshes its source document without details or read-mark mutation",async()=>{
  const automatic=(path:string)=>({...inquiry(),type:"automatic_sick_permit",document_id:"synthetic-stable-document",medical_forms_documents:[{result_file:path,timestamp:"time",hash:"hash"}]});
  const t=new MockTransport([bootstrap(),{inquiries:[automatic("initial.pdf")]},{inquiries:[automatic("rotated.pdf")]},pdf()]);
  const reader=await MaccabiReaders.create(t),list=await reader.listInquiries(),ref=list.data[0]!.pdf_reference as string;
  expect(ref).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(list)).not.toMatch(/initial.pdf|result_file|"hash"/);
  await reader.getInquiryDocumentPdf("314",ref);
  expect(t.calls.at(-1)!.path).toContain("path=rotated.pdf");
  expect(t.calls).toHaveLength(4);
  expect(t.calls.every(call=>!call.init?.method)).toBe(true);
});

test("automatic document discovery rejects missing identity, extra documents, unsafe signatures and owner drift",async()=>{
  const row={...inquiry(),type:"automatic_sick_permit",document_id:"stable",medical_forms_documents:[{result_file:"file.pdf",timestamp:"time",hash:"hash"}]};
  // A second document could not be addressed anyway: the one reference is keyed on the row's document_id.
  for(const value of [{...row,document_id:null},{...row,medical_forms_documents:[{...row.medical_forms_documents[0],hash:"bad&query=1"}]},{...row,medical_forms_documents:[row.medical_forms_documents[0],{...row.medical_forms_documents[0],result_file:"second.pdf"}]},{...row,medical_forms_documents:[{...row.medical_forms_documents[0],member_id:999}]}]){
    const t=new MockTransport([bootstrap(),{inquiries:[value]}]);
    await expect((await MaccabiReaders.create(t)).listInquiries()).rejects.toMatchObject({code:value.medical_forms_documents[0] && "member_id" in value.medical_forms_documents[0]?"OWNER_MISMATCH":"INVALID_RESPONSE"});
    expect(t.calls).toHaveLength(2);
  }
});

test("associated visit returns decoded source-visible tutorial links without fetching targets",async()=>{
  for(const type_id of [2,3]){
    const t=new MockTransport([bootstrap(),{inquiries:[inquiry()]},detail(),{...visit(),tutorials:[{type_id,item_title:"Synthetic link",item_url:"https%3A%2F%2Fexample.invalid%2Fguide%3Fq%3Da%2520b"}]}]);
    const output=await(await MaccabiReaders.create(t)).getInquiry("314");
    const tutorial=((output.data.visit_summary as {data:{tutorials:Record<string,unknown>[]}}).data.tutorials)[0]!;
    expect(tutorial).toEqual({type_id,item_title:"Synthetic link",link:"https://example.invalid/guide?q=a%20b"});
    tutorial.link="https://caller.invalid";
    expect(t.calls).toHaveLength(4);
  }
  for(const item_url of ["bad%2","javascript%3Aalert(1)","https%3A%2F%2Fuser%3Asecret%40example.invalid%2F","https%3A%2F%2Fexample.invalid%2F%0A"]){
    const t=new MockTransport([bootstrap(),{inquiries:[inquiry()]},detail(),{...visit(),tutorials:[{type_id:3,item_url}]}]);
    await expect((await MaccabiReaders.create(t)).getInquiry("314")).rejects.toMatchObject({code:"INVALID_RESPONSE"});
    expect(t.calls).toHaveLength(4);
  }
});
