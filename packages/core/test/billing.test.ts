import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { MaccabiReaders, type ReadTransport } from "../src/readers";
import { parseBillingPeriods, parseQuarterlyBillingRows, parseQuarterlyBillingDocuments } from "../src/readers/billing";
const owner = { member_id:123456789, member_id_code:"0", f_name_hebrew:"דוגמה", l_name_hebrew:"בדיקה", f_name_english:"Example", l_name_english:"Fixture", birth_date:"2000-01-01", sex:"synthetic", session_id:"fixture-navigation" };
const bootstrap = () => ({session_id:"fixture-navigation",logged_customer_info:owner,current_customer_info:owner,token:{success:true,content:"fixture-token"}});
const page = (options = '<option value="3">תקופה לדוגמה</option><option value="0">הכל</option>', id = owner.member_id) => `<header><span id="ctl00_ctl00_wcSiteHeaderLobby1_wcSiteHeaderCurrentPatient_wcSiteHeaderChildrenList_lblCustomerIDNumber">${id}</span></header><script>jqe.appRoot='/online';</script><input id="isUnderConstruction" value="0"><select id="PeriodSelectDropDownList">${options}</select>`;
const fragment = (rows = '<ul class="rowgroup"><li><span>תקופה לדוגמה</span><span>original-date</span><span><a class="reportFound" onclick="QuarterlyReport.OpenReportPdf(\'private-access-token\',\'private-type\')">לצפייה</a></span></li></ul>', total = 1) => `<div class="dataGrid"><div class="quaterly_table"><div class="maintable"><ul class="headinggroup"><li class="headinggroup"><span>Period</span><span>Production date</span><span>Reports</span></li></ul>${rows}</div></div></div><input id="GridNumOfResultsHidden" value="${total}"><input id="GridTotalPagesHidden" value="1">`;
function legacyResponse(text: string, mime: string): Response {
  const bytes = Uint8Array.from([...text], ch => ch.charCodeAt(0) >= 0x5d0 && ch.charCodeAt(0) <= 0x5ea ? ch.charCodeAt(0) - 0x5d0 + 0xe0 : ch.charCodeAt(0));
  return new Response(bytes, {headers:{"content-type":`${mime}; charset=windows-1255`}});
}
class Mock implements ReadTransport {
  calls: {path:string;init?:RequestInit & {apiAuthorization?:boolean}}[]=[];
  constructor(private responses: unknown[]) {}
  setApiToken() {}
  async getOrCreatePortalNavigationSession() { return "fixture+navigation"; }
  async request(path: string|URL, init?:RequestInit & {apiAuthorization?:boolean}) {this.calls.push({path:String(path),init});const next=this.responses.shift();return next instanceof Response?next:Response.json(next);}
}
test("quarterly billing uses fresh owner page default and preserves Windows-1255 visible catalog text",async()=>{
  const transport=new Mock([bootstrap(),legacyResponse(page(),"text/html"),legacyResponse(JSON.stringify({d:fragment()}),"application/json")]);
  const result=await (await MaccabiReaders.create(transport)).listQuarterlyBillingReports();
  expect(result.data.availablePeriods).toHaveLength(2);
  expect(result.data.selectedPeriod).toEqual({value:"3",label:"תקופה לדוגמה"});
  expect(result.data.reports).toEqual([{period:"תקופה לדוגמה",productionDate:"original-date",viewLabel:"לצפייה",reference:expect.stringMatching(/^[a-f0-9]{64}$/)}]);
  expect(result.data.pagination).toEqual({returned:1,reportedResultCount:1,totalPages:1,currentPage:1});
  expect(transport.calls[2]!.init).toMatchObject({method:"POST",apiAuthorization:false,body:"{'value':'3'}"});
  expect(JSON.stringify(result)).not.toContain("private-access-token");
  expect(JSON.stringify(result)).not.toContain("\ufffd");
});
test("quarterly billing period is selected only from fresh options and owner mismatch prevents POST",async()=>{
  const transport=new Mock([bootstrap(),legacyResponse(page(),"text/html"),legacyResponse(JSON.stringify({d:fragment()}),"application/json")]);
  expect((await (await MaccabiReaders.create(transport)).listQuarterlyBillingReports("0")).data.selectedPeriod.value).toBe("0");
  expect(transport.calls[2]!.init?.body).toBe("{'value':'0'}");
  for (const [html,period,code] of [[page(),"2024","UNSUPPORTED_FLOW"],[page(undefined,222222222),undefined,"OWNER_MISMATCH"]] as const){
    const t=new Mock([bootstrap(),legacyResponse(html,"text/html")]);
    await expect((await MaccabiReaders.create(t)).listQuarterlyBillingReports(period)).rejects.toMatchObject({code});
    expect(t.calls).toHaveLength(2);
  }
});
test("quarterly catalog rejects malformed options, counts, envelopes and shifted response origin",async()=>{
  expect(()=>parseBillingPeriods(page('<option value="0">A</option><option value="0">B</option>'))).toThrow();
  expect(()=>parseQuarterlyBillingRows(fragment("",1))).toThrow();
  expect(()=>parseQuarterlyBillingRows(fragment(undefined,0))).toThrow();
  const malformed=[Response.json({d:true}),Response.json({d:fragment(),token:"fixture"}),Response.json({d:fragment()})];
  Object.defineProperty(malformed[2],"url",{value:"https://example.invalid/other"});
  for(const response of malformed){
    const t=new Mock([bootstrap(),legacyResponse(page(),"text/html"),response]);
    await expect((await MaccabiReaders.create(t)).listQuarterlyBillingReports()).rejects.toMatchObject({code:"INVALID_RESPONSE"});
  }
  const selected=parseBillingPeriods(page('<option value="3">A</option><option value="0" selected>B</option>'));
  expect(selected.defaultPeriod.value).toBe("0");
});

const reportRow = (token = "private%2Btoken+raw", reportType = "fixture-report") => `<ul class="rowgroup"><li><span>תקופה לדוגמה</span><span>original-date</span><span><a class="reportFound" onclick="QuarterlyReport.OpenReportPdf(&#39;${token}&#39;,&#39;${reportType}&#39;)">לצפייה</a></span></li></ul>`;
const reportReference = () => createHash("sha256").update(JSON.stringify(["תקופה לדוגמה","original-date","fixture-report"])).digest("hex");
const catalogResponse = (rows=reportRow(), total=1) => legacyResponse(JSON.stringify({d:fragment(rows,total)}),"application/json");
const originalPdf = () => new Response("%PDF-1.7\nsynthetic original report",{headers:{"content-type":"application/pdf"}});
test("quarterly PDF refreshes owner period catalog, tolerates token rotation and uses captured archive/PDF pair",async()=>{
 const first=new Mock([bootstrap(),legacyResponse(page(),"text/html"),catalogResponse()]);
 const catalog=await(await MaccabiReaders.create(first)).listQuarterlyBillingReports();
 expect(catalog.data.reports[0]!.reference).toBe(reportReference());
 expect(JSON.stringify(catalog)).not.toMatch(/private|fixture-report|OpenReportPdf|token/);
 catalog.data.reports[0]!.period="caller changed";
 const next=new Mock([bootstrap(),legacyResponse(page(),"text/html"),catalogResponse(reportRow("rotated%2Btoken+raw")),Response.json({d:true}),originalPdf()]);
 const result=await(await MaccabiReaders.create(next)).getQuarterlyBillingReportPdf(reportReference(),"3");
 expect(new TextDecoder().decode(result.data)).toBe("%PDF-1.7\nsynthetic original report");
 expect(result.source.operation).toBe("quarterly-billing-report-pdf");
 expect(next.calls[3]!.init).toMatchObject({method:"POST",apiAuthorization:false,body:"{'token':'rotated%2Btoken+raw', 'reportType':'fixture-report'}"});
 expect(next.calls[4]!.path).toBe("/online/Pages/Popups/DebitsAndCredits/DebitsAndCreditsPdfReport.aspx?token=rotated%2Btoken+raw&ReportType=fixture-report&FileName=DebitsAndCreditsReportInformation");
 expect(next.calls[4]!.init?.apiAuthorization).toBe(false);
});
test("quarterly PDF unknown and ambiguous visible references stop before archive retrieval",async()=>{
 for(const [rows,total,reference,code] of [[reportRow(),1,"a".repeat(64),"OWNER_MISMATCH"],[reportRow()+reportRow("different-token"),2,reportReference(),"INVALID_RESPONSE"]] as const){
  const transport=new Mock([bootstrap(),legacyResponse(page(),"text/html"),catalogResponse(rows,total)]);
  await expect((await MaccabiReaders.create(transport)).getQuarterlyBillingReportPdf(reference,"3")).rejects.toMatchObject({code});
  expect(transport.calls).toHaveLength(3);
 }
});
test("quarterly PDF rejects unobserved controls/signatures and archive failure without attempting PDF",async()=>{
 for(const rows of [reportRow("bad%2"),reportRow("bad&selector"),reportRow().replace("QuarterlyReport.OpenReportPdf","OtherAction")]){
  const transport=new Mock([bootstrap(),legacyResponse(page(),"text/html"),catalogResponse(rows)]);
  await expect((await MaccabiReaders.create(transport)).getQuarterlyBillingReportPdf(reportReference(),"3")).rejects.toMatchObject({code:"INVALID_RESPONSE"});
  expect(transport.calls).toHaveLength(3);
 }
 for(const [body,code] of [[{d:false},"UPSTREAM_RESULT_ERROR"],[{d:"true"},"INVALID_RESPONSE"],[{d:true,unexpected:"fixture"},"INVALID_RESPONSE"]] as const){
  const transport=new Mock([bootstrap(),legacyResponse(page(),"text/html"),catalogResponse(),Response.json(body)]);
  await expect((await MaccabiReaders.create(transport)).getQuarterlyBillingReportPdf(reportReference(),"3")).rejects.toMatchObject({code});
  expect(transport.calls).toHaveLength(4);
 }
});
test("quarterly PDF checks the final document selectors and size",async()=>{
 const shifted=originalPdf();Object.defineProperty(shifted,"url",{value:"https://online.maccabi4u.co.il/online/Pages/Popups/DebitsAndCredits/DebitsAndCreditsPdfReport.aspx?token=other"});
 const oversized=new Response("%PDF-fixture",{headers:{"content-type":"application/pdf","content-length":String(2*1024*1024+1)}});
 for(const response of [shifted,oversized,new Response("not PDF",{headers:{"content-type":"application/pdf"}})]){
  const transport=new Mock([bootstrap(),legacyResponse(page(),"text/html"),catalogResponse(),Response.json({d:true}),response]);
  await expect((await MaccabiReaders.create(transport)).getQuarterlyBillingReportPdf(reportReference(),"3")).rejects.toMatchObject({code:"INVALID_RESPONSE"});
 }
});

test("quarterly selection identity changes with its visible tuple/type and archive redirects fail",async()=>{
 const original=parseQuarterlyBillingRows(fragment(reportRow()));
 const changedType=parseQuarterlyBillingDocuments(fragment(reportRow("token","another-report-type")),original.reports)[0]!.reference;
 const changedPeriod=parseQuarterlyBillingDocuments(fragment(reportRow()),[{...original.reports[0]!,period:"different visible period"}])[0]!.reference;
 expect(changedType).not.toBe(reportReference());expect(changedPeriod).not.toBe(reportReference());
 const missingPeriod=new Mock([bootstrap(),legacyResponse(page(),"text/html")]);
 await expect((await MaccabiReaders.create(missingPeriod)).getQuarterlyBillingReportPdf(reportReference(),"1999")).rejects.toMatchObject({code:"UNSUPPORTED_FLOW"});
 expect(missingPeriod.calls).toHaveLength(2);
 const shifted=Response.json({d:true});Object.defineProperty(shifted,"url",{value:"https://online.maccabi4u.co.il/online/Ajax/DebitsAndCredits/WcDebitsAndCreditsManager.asmx/GetDocFromArchive?other=fixture"});
 const transport=new Mock([bootstrap(),legacyResponse(page(),"text/html"),catalogResponse(),shifted]);
 await expect((await MaccabiReaders.create(transport)).getQuarterlyBillingReportPdf(reportReference(),"3")).rejects.toMatchObject({code:"INVALID_RESPONSE"});
 expect(transport.calls).toHaveLength(4);
});

const nursingFragment=(token='private%2Btoken+raw')=>`<div class="dataGrid"><div class="more_info showinfobox"><div class="yearly_table"><div class="maintable"><ul class="headinggroup"><li class="headinggroup"><span>Period</span><span>Production date</span><span>Reports</span></li></ul><ul class="rowgroup"><li><span>תקופה לדוגמה</span><span>original-date</span><span><a onclick="LTCReport.OpenReportPdf('${token}', 'fixture-report');">לצפייה</a></span></li></ul></div></div></div></div><div id="moreResults"></div><input id="GridNumOfResultsHidden" value="1"><input id="GridTotalPagesHidden" value="1">`;
const nursingResponse=(token?:string)=>legacyResponse(JSON.stringify({d:nursingFragment(token)}),'application/json');
test('annual nursing catalog and PDF use owner page, empty wire body, rotating token and exact uppercase popup key',async()=>{
 const first=new Mock([bootstrap(),legacyResponse(page(),'text/html'),nursingResponse()]);
 const catalog=await(await MaccabiReaders.create(first)).listNursingInsuranceReports();
 expect(catalog.data.reports[0]!.period).toBe('תקופה לדוגמה');
 expect(first.calls[2]!.init).toMatchObject({method:'POST',apiAuthorization:false,body:''});
 expect(first.calls[2]!.path.endsWith('/GetLTCReport')).toBe(true);
 expect(JSON.stringify(catalog)).not.toMatch(/private|fixture-report|token/);
 const next=new Mock([bootstrap(),legacyResponse(page(),'text/html'),nursingResponse('rotated%2Btoken+raw'),Response.json({d:true}),originalPdf()]);
 await(await MaccabiReaders.create(next)).getNursingInsuranceReportPdf(catalog.data.reports[0]!.reference!);
 expect(next.calls[3]!.init?.body).toBe("{'token':'rotated%2Btoken+raw', 'reportType':'fixture-report'}");
 expect(next.calls[4]!.path).toContain('?Token=rotated%2Btoken+raw&ReportType=fixture-report&FileName=DebitsAndCreditsReportInformation');
 expect(next.calls[4]!.init?.apiAuthorization).toBe(false);
});
test('annual owner mismatch, unknown reference and archive failure stop before PDF',async()=>{
 const mismatch=new Mock([bootstrap(),legacyResponse(page(undefined,222222222),'text/html')]);
 await expect((await MaccabiReaders.create(mismatch)).listNursingInsuranceReports()).rejects.toMatchObject({code:'OWNER_MISMATCH'});
 expect(mismatch.calls).toHaveLength(2);
 const unknown=new Mock([bootstrap(),legacyResponse(page(),'text/html'),nursingResponse()]);
 await expect((await MaccabiReaders.create(unknown)).getNursingInsuranceReportPdf('a'.repeat(64))).rejects.toMatchObject({code:'OWNER_MISMATCH'});
 expect(unknown.calls).toHaveLength(3);
 const listed=await(await MaccabiReaders.create(new Mock([bootstrap(),legacyResponse(page(),'text/html'),nursingResponse()]))).listNursingInsuranceReports();
 const failure=new Mock([bootstrap(),legacyResponse(page(),'text/html'),nursingResponse(),Response.json({d:false})]);
 await expect((await MaccabiReaders.create(failure)).getNursingInsuranceReportPdf(listed.data.reports[0]!.reference!)).rejects.toMatchObject({code:'UPSTREAM_RESULT_ERROR'});
 expect(failure.calls).toHaveLength(4);
});
