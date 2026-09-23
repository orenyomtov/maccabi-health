import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { MaccabiReaders, type ReadTransport } from "../src/readers";
const owner={member_id:123456789,member_id_code:"0",f_name_hebrew:"דוגמה",l_name_hebrew:"בדיקה",f_name_english:"Example",l_name_english:"Fixture",birth_date:"2000-01-01",sex:"synthetic"};
const bootstrap=()=>({logged_customer_info:owner,current_customer_info:owner,token:{success:true,content:"fixture-token"}});
const visitRow={appointment_id:"fixture-visit",appointment_date:"source-date",service_provider_name:"רופא לדוגמה",service_name:"שירות",has_summery_file:true};
const visit=()=>({member_id:String(owner.member_id),member_id_code:owner.member_id_code,visit_summary_date:"source-date",service_provider_name:"רופא לדוגמה",visit_summary_pdf_link:"private+path%2Fpart",timestamp:"fixture%2Btime",hash:"fixture+hash%2Btail",diagnosis:[{diagnosis_description:"טקסט מקורי"}]});
const inquiry=()=>({member_id:String(owner.member_id),member_id_code:0,request_id:"314",type:"medical_form_request",service_provider_name:"רופא לדוגמה",request_status:"תשובה",request_status_code:"1",status_update_date:"source-date"});
const form=()=>({document_id:42,form_type:1,document_description:"מסמך מקורי",link_pdf:"private+approval%2Fpart",timestamp:"fixture%2Btime",hash:"fixture+hash%2Btail"});
const detail=()=>({request_id:314,user_id:owner.member_id,user_code:0,patient_remark:"טקסט מקורי",doctor_remark:"תשובה",creation_date:"source-date",update_date:"source-date",doctor_name:"רופא",request_status_desc:"תשובה",prescription_largo_code_list:[],approval_request_details:[],prescription_user_drugs_indication:[],medical_forms_details:[form()]});
const ref=(row=form())=>createHash("sha256").update(JSON.stringify(["314",row.form_type,row.link_pdf])).digest("hex");
const pdf=()=>new Response("%PDF-1.7\noriginal synthetic bytes",{headers:{"content-type":"application/pdf"}});
class Mock implements ReadTransport{
 calls:{path:string;init?:RequestInit & {apiAuthorization?:boolean}}[]=[];
 constructor(private responses:unknown[]){}
 setApiToken(){}
 async request(path:string|URL,init?:RequestInit & {apiAuthorization?:boolean}){this.calls.push({path:String(path),init});const next=this.responses.shift();return next instanceof Response?next:Response.json(next);}
}
test("visit PDF refreshes owner history/detail and exactly mirrors source component encoding",async()=>{
 const t=new Mock([bootstrap(),{results:[visitRow]},visit(),pdf()]);
 const result=await(await MaccabiReaders.create(t)).getVisitSummaryPdf(visitRow.appointment_id);
 expect(new TextDecoder().decode(result.data)).toBe("%PDF-1.7\noriginal synthetic bytes");
 expect(result.source.operation).toBe("visit-summary-pdf");
 expect(t.calls[3]!.path).toBe("/sonline/AppointmentOrderAPI/webapi/mac/v1/members/0/123456789/pdf?path=private%2Bpath%252Fpart&timestamp=fixture%2Btime&hash=fixture+hash%2Btail");
 expect(t.calls[3]!.init?.apiAuthorization).toBe(false);
 const output=await(await MaccabiReaders.create(new Mock([bootstrap(),{results:[visitRow]},visit()]))).getVisit(visitRow.appointment_id);
 expect(output.data.has_summary_pdf).toBe(true);
 expect(output.data.diagnosis).toEqual([{diagnosis_description:"טקסט מקורי"}]);
 expect(JSON.stringify(output)).not.toMatch(/private|fixture%2B|fixture\+hash|visit_summary_pdf_link|"timestamp"|"hash"/);
});
test("visit PDF rejects unknown/ambiguous history, owner mismatch and missing document before download",async()=>{
 for(const [rows,data,code,count] of [[[],visit(),"OWNER_MISMATCH",2],[[visitRow,visitRow],visit(),"INVALID_RESPONSE",2],[[{...visitRow,has_summery_file:false}],visit(),"UNSUPPORTED_FLOW",2],[[visitRow],{...visit(),member_id:"999"},"OWNER_MISMATCH",3],[[visitRow],{...visit(),visit_summary_pdf_link:""},"UNSUPPORTED_FLOW",3]] as const){
  const t=new Mock([bootstrap(),{results:rows},data]);
  await expect((await MaccabiReaders.create(t)).getVisitSummaryPdf(visitRow.appointment_id)).rejects.toMatchObject({code});
  expect(t.calls).toHaveLength(count);
 }
});
test("inquiry approval references are private, type gated, fresh and unaffected by signature rotation",async()=>{
 const first=detail(),latest=detail();latest.medical_forms_details[0]!.hash="rotated%2Bsignature";
 const t=new Mock([bootstrap(),{inquiries:[inquiry()]},first,{inquiries:[inquiry()]},latest,pdf()]);
 const reader=await MaccabiReaders.create(t), output=await reader.getInquiry("314");
 const rows=output.data.medical_forms_details as Record<string,unknown>[];
 expect(rows[0]!.pdf_reference).toBe(ref());
 expect(JSON.stringify(output)).not.toMatch(/private|timestamp|hash|link_pdf/);
 rows[0]!.pdf_reference="caller-mutated";
 const result=await reader.getInquiryDocumentPdf("314",ref());
 expect(result.source.operation).toBe("inquiry-document-pdf");
 expect(t.calls[5]!.path.endsWith("&hash=rotated%2Bsignature")).toBe(true);
 expect(t.calls[5]!.init?.apiAuthorization).toBe(false);
 const type5={...form(),form_type:5};
 const five=new Mock([bootstrap(),{inquiries:[{...inquiry(),request_status_code:"8"}]},{...detail(),medical_forms_details:[type5]},pdf()]);
 expect((await(await MaccabiReaders.create(five)).getInquiryDocumentPdf("314",ref(type5))).data.length).toBeGreaterThan(5);
});
test("inquiry approval rejects unknown/duplicate refs, hidden status/associated-visit branch and unsupported form types",async()=>{
 for(const [row,data,reference,code] of [
  [inquiry(),detail(),"a".repeat(64),"OWNER_MISMATCH"],
  [inquiry(),{...detail(),medical_forms_details:[form(),form()]},ref(),"INVALID_RESPONSE"],
  [{...inquiry(),request_status_code:"0"},detail(),ref(),"OWNER_MISMATCH"],
  [inquiry(),{...detail(),open_medical_record_number:""},ref(),"OWNER_MISMATCH"],
  [inquiry(),{...detail(),medical_forms_details:[{...form(),form_type:9}]},ref(),"OWNER_MISMATCH"],
  [{...inquiry(),type:"automatic_sick_permit",medical_forms_documents:[]},detail(),ref(),"OWNER_MISMATCH"],
  [inquiry(),{...detail(),user_id:999},ref(),"OWNER_MISMATCH"],
 ] as const){
  const t=new Mock([bootstrap(),{inquiries:[row]},data]);
  await expect((await MaccabiReaders.create(t)).getInquiryDocumentPdf("314",reference)).rejects.toMatchObject({code});
  expect(t.calls.some(c=>c.path.includes("/pdf?"))).toBe(false);
 }
});
test("new PDF contracts reject malformed source components, redirected selectors, bad bytes and oversized documents",async()=>{
 for(const hash of ["malformed%2","injected&other=1","fragment#tail"]){
  const t=new Mock([bootstrap(),{results:[visitRow]},{...visit(),hash}]);
  await expect((await MaccabiReaders.create(t)).getVisitSummaryPdf(visitRow.appointment_id)).rejects.toMatchObject({code:"INVALID_RESPONSE"});
  expect(t.calls).toHaveLength(3);
 }
 const shifted=pdf();Object.defineProperty(shifted,"url",{value:"https://online.maccabi4u.co.il/sonline/AppointmentOrderAPI/webapi/mac/v1/members/0/123456789/pdf?path=other"});
 for(const response of [shifted,new Response("not PDF",{headers:{"content-type":"application/pdf"}}),new Response("%PDF-fixture",{headers:{"content-type":"text/html"}}),new Response("%PDF-fixture",{headers:{"content-type":"application/pdf","content-length":String(2*1024*1024+1)}}),new Response(new Uint8Array(2*1024*1024+1),{headers:{"content-type":"application/pdf"}})]){
  const t=new Mock([bootstrap(),{results:[visitRow]},visit(),response]);
  await expect((await MaccabiReaders.create(t)).getVisitSummaryPdf(visitRow.appointment_id)).rejects.toMatchObject({code:"INVALID_RESPONSE"});
 }
});
