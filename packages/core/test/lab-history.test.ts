import { describe, expect, test } from 'vitest';
import { MaccabiReaders, type ReadTransport } from '../src/readers';
import { FIXTURE_MEMBER_ID, testRow } from './fixtures/test-rows';
const owner={member_id:FIXTURE_MEMBER_ID,member_id_code:'0',f_name_hebrew:'דוגמה',l_name_hebrew:'בדיקה',f_name_english:'Example',l_name_english:'Fixture',birth_date:'2000-01-01',sex:'synthetic'};
const bootstrap=()=>({logged_customer_info:owner,current_customer_info:owner,token:{content:'synthetic',success:true}});
const row=()=>({test_id:'fixture-test',test_desc:'בדיקה לדוגמה',units:'unit',message:'',message_list:['מקור'],lab_date:'2025-01-01',min_lim:1,max_lim:3,result:2,numeric_percentage:50,is_messages:'source',is_vitek:false,is_follow:false,vitek_row:[],result_file:null,time_stamp:null,hash:null});
const latest=()=>({results:[{group_name:'קבוצה',group_values:[row()]}],time_stamp:'time',hash:'signature%2B%2F'});
class Transport implements ReadTransport {
 calls:{path:string;init?:RequestInit & {apiAuthorization?:boolean}}[]=[];
 constructor(readonly responses:unknown[]){}
 setApiToken(){}
 async request(input:string|URL,init?:RequestInit & {apiAuthorization?:boolean}){this.calls.push({path:String(input),init});const value=this.responses.shift();return value instanceof Response?value:Response.json(value);}
}
const pdf=()=>new Response('%PDF-synthetic',{headers:{'content-type':'application/pdf'}});
describe('latest laboratory results',()=>{
 test('projects clinical groups and downloads the fresh unfiltered original report',async()=>{
  const transport=new Transport([bootstrap(),latest(),latest(),pdf()]);
  const readers=await MaccabiReaders.create(transport);
  const result=await readers.listLatestLabResults();
  expect(result.data[0]!.group_values[0]!.result).toBe(2);
  expect(JSON.stringify(result)).not.toMatch(/signature|time_stamp|"hash"/);
  await readers.getLatestLabResultsPdf();
  const call=transport.calls.at(-1)!;
  expect(call.path).toContain('/getlatestlabresults/report?');
  expect(Object.fromEntries(new URL(call.path,'https://synthetic.invalid').searchParams)).toEqual({t:'time',hash:'signature+/',irregular_only:'false',is_attachment:'false'});
  expect(call.init?.apiAuthorization).toBe(false);
 });
 test('rejects nested owner drift and non-PDF or redirected reports',async()=>{
  const bad=latest();Object.assign(bad.results[0]!.group_values[0]!,{member_id:222222222});
  const readers=await MaccabiReaders.create(new Transport([bootstrap(),bad]));
  await expect(readers.listLatestLabResults()).rejects.toMatchObject({code:'OWNER_MISMATCH'});
  for(const response of [new Response('not-pdf',{headers:{'content-type':'application/pdf'}}),pdf()]){
   const transport=new Transport([bootstrap(),latest(),response]);
   if(response.headers.get('content-type')==='application/pdf'&&(await response.clone().text()).startsWith('%PDF-'))Object.defineProperty(response,'url',{value:'https://online.maccabi4u.co.il/sonline/TestResultsAPI/webapi/mac/v1/members/0/123456789/getlatestlabresults/report?t=wrong'});
   await expect((await MaccabiReaders.create(transport)).getLatestLabResultsPdf()).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  }
 });
});

const tests=()=>({categories:[],tests:[testRow('lab_result',{request_id:'request',doc_id:'doc'})]});
// getresultsbyid returns exactly these keys. It does NOT echo request_id back - a fixture that invented
// one hid the fact that both report downloads could never build a URL.
const detail=()=>({...latest(),corona_hash:null,corona_t:null,execute_date:'2025-01-01',is_partial:false,is_read:true,referrer_name:null,show_print_corona_english_report:false});
const comparison=()=>({current_result:{...row(),doc_first_name:'Example',doc_last_name:'Clinician',is_graph:true},other_results:[{...row(),lab_date:'2024-01-01',doc_first_name:'Example',doc_last_name:'Clinician',is_graph:true}],timestamp:'time',hash:'signature%2B%2F'});
describe('owner-bound laboratory comparisons',()=>{
 test('derives selected date from fresh parent detail and preserves history without signatures',async()=>{
  const transport=new Transport([bootstrap(),tests(),detail(),comparison()]);
  const readers=await MaccabiReaders.create(transport);
  const result=await readers.getLabComparison({source:'result',requestId:'request',docId:'doc',testId:'fixture-test'});
  expect(result.data.other_results[0]!.lab_date).toBe('2024-01-01');
  expect(JSON.stringify(result)).not.toMatch(/signature|timestamp|"hash"/);
  expect(Object.fromEntries(new URL(transport.calls.at(-1)!.path,'https://synthetic.invalid').searchParams)).toEqual({test_id:'fixture-test',date_of_result:'2025-01-01'});
 });
 test('original list-view comparison PDF uses only refreshed server metadata',async()=>{
  const transport=new Transport([bootstrap(),tests(),detail(),comparison(),pdf()]);
  await (await MaccabiReaders.create(transport)).getLabComparisonPdf({source:'result',requestId:'request',docId:'doc',testId:'fixture-test'});
  const call=transport.calls.at(-1)!;
  expect(call.path).toContain('/compare/0/123456789/compare/report?');
  expect(Object.fromEntries(new URL(call.path,'https://synthetic.invalid').searchParams)).toEqual({test_id:'fixture-test',t:'time',hash:'signature+/',date_of_result:'2025-01-01',is_attachment:'false',is_graph:'false',test_des:'בדיקה לדוגמה',lab_date:'2025-01-01'});
  expect(call.init?.apiAuthorization).toBe(false);
 });
 test('unknown or ambiguous nested tests and changed comparison identity fail closed',async()=>{
  const duplicate=detail();duplicate.results[0]!.group_values.push(row());
  for(const data of [duplicate,{...detail(),results:[]}]){
   const transport=new Transport([bootstrap(),tests(),data]);
   await expect((await MaccabiReaders.create(transport)).getLabComparison({source:'result',requestId:'request',docId:'doc',testId:'fixture-test'})).rejects.toMatchObject({code:'OWNER_MISMATCH'});
   expect(transport.calls).toHaveLength(3);
  }
  const wrong=comparison();wrong.current_result.test_id='other';
  await expect((await MaccabiReaders.create(new Transport([bootstrap(),tests(),detail(),wrong]))).getLabComparison({source:'result',requestId:'request',docId:'doc',testId:'fixture-test'})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  const noParent=new Transport([bootstrap(),{categories:[],tests:[]}]);
  await expect((await MaccabiReaders.create(noParent)).getLabComparison({source:'result',requestId:'request',docId:'doc',testId:'fixture-test'})).rejects.toMatchObject({code:'OWNER_MISMATCH'});
  expect(noParent.calls).toHaveLength(2);
 });
});

describe('existing followed laboratory results',()=>{
 const followed=()=>({followed_counter:1,followed_tests:[row()],options:[{test_id:'fixture-test',test_desc:'בדיקה',is_follow:true}],timestamp:'time+',hash:'signature%2B'});
 test('returns tracking state and original report without toggle or read-marker calls',async()=>{
  const transport=new Transport([bootstrap(),followed(),followed(),pdf()]);const readers=await MaccabiReaders.create(transport);
  const result=await readers.listFollowedLabResults();
  expect(result.data.options[0]!.is_follow).toBe(true);
  expect(result.source.schemaEvidence).toBe('frontend-field-projection');
  expect(JSON.stringify(result)).not.toMatch(/signature|timestamp/);
  await readers.getFollowedLabResultsPdf();
  expect(transport.calls.at(-1)!.path).toContain('/followed/report?t=time+&hash=signature%2B&is_attachment=false');
  expect(transport.calls.at(-1)!.init?.apiAuthorization).toBe(false);
  expect(transport.calls.every(call=>!call.path.includes('toggletest')&&!call.path.includes('/read/'))).toBe(true);
 });
 test('rejects owner drift and malformed source-only report signatures',async()=>{
  const wrong=followed();Object.assign(wrong.options[0]!,{member_id:222222222});
  await expect((await MaccabiReaders.create(new Transport([bootstrap(),wrong]))).listFollowedLabResults()).rejects.toMatchObject({code:'OWNER_MISMATCH'});
  const unsafe={...followed(),hash:'bad&field=other'};
  const transport=new Transport([bootstrap(),unsafe]);
  await expect((await MaccabiReaders.create(transport)).getFollowedLabResultsPdf()).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  expect(transport.calls).toHaveLength(2);
 });
});


test.each(['latest','followed'] as const)('comparison resolves unique current %s row without caller dates',async source=>{
 const selected=source==='latest'?latest():{followed_counter:1,followed_tests:[row()],options:[],timestamp:'time',hash:'hash'};
 const transport=new Transport([bootstrap(),selected,comparison()]);const readers=await MaccabiReaders.create(transport);
 expect((await readers.getLabComparison({source,testId:'fixture-test'})).data.other_results).toHaveLength(1);
 expect(transport.calls[1]!.path).toContain(source==='latest'?'/getlatestlabresults':'/followed');
 expect(transport.calls).toHaveLength(3);
 const invalid=new Transport([bootstrap()]);const other=await MaccabiReaders.create(invalid);
 await expect(other.getLabComparison({source,testId:'fixture-test',requestId:'contradictory'} as any)).rejects.toBeInstanceOf(TypeError);
 expect(invalid.calls).toHaveLength(1);
});

test('individual full lab report resolves fresh owner detail and preserves source print query',async()=>{
 const source=detail();
 // Regression: the detail body carries no request_id. The download must still reach the source.
 expect('request_id' in source).toBe(false);
 const transport=new Transport([bootstrap(),tests(),source,pdf()]);
 await(await MaccabiReaders.create(transport)).getLabReportPdf('request','doc');
 expect(transport.calls.at(-1)!.path).toContain('/getresultsbyid/report?request_id=request&t=time&hash=signature%2B%2F&irregular_only=false&is_attachment=false&is_partial=false&date=2025-01-01');
 expect(transport.calls.at(-1)!.init?.apiAuthorization).toBe(false);
 // A body the query cannot be built from is an upstream shape failure, not an ownership failure.
 const broken=new Transport([bootstrap(),tests(),{...detail(),hash:null}]);
 await expect((await MaccabiReaders.create(broken)).getLabReportPdf('request','doc')).rejects.toMatchObject({code:'INVALID_RESPONSE'});
 expect(broken.calls).toHaveLength(3);
});

test('a request/doc pair listed twice is an upstream contradiction, not an ownership failure',async()=>{
 const listed=tests();const duplicated={categories:[],tests:[listed.tests[0]!,{...listed.tests[0]!}]};
 const transport=new Transport([bootstrap(),duplicated]);
 await expect((await MaccabiReaders.create(transport)).getLabReportPdf('request','doc')).rejects.toMatchObject({code:'INVALID_RESPONSE',operation:'lab-report-pdf'});
 expect(transport.calls).toHaveLength(2);
 const absent=new Transport([bootstrap(),tests()]);
 await expect((await MaccabiReaders.create(absent)).getLabReportPdf('other-request','doc')).rejects.toMatchObject({code:'OWNER_MISMATCH',operation:'lab-report-pdf'});
 expect(absent.calls).toHaveLength(2);
});

test.each(['latest','followed'] as const)('file attachment resolves a unique fresh %s row and does not expose its private path',async source=>{
 const file={...row(),result_file:'private+file',time_stamp:'time',hash:'signature%2B%2F'};
 const input=source==='latest'?{...latest(),results:[{group_name:'group',group_values:[file]}]}:{followed_counter:1,followed_tests:[file],options:[],timestamp:'time',hash:'signature'};
 const transport=new Transport([bootstrap(),input,pdf()]);
 await(await MaccabiReaders.create(transport)).getLabResultFilePdf({source,testId:'fixture-test'});
 expect(transport.calls.at(-1)!.path).toContain('/pdf/showresult?data=private%2Bfile&t=time&hash=signature%2B%2F');
 expect(transport.calls.at(-1)!.init?.apiAuthorization).toBe(false);
});

test('English COVID lab report supports only eligible existing-profile direct print and never writes identity',async()=>{
 const current={...owner,passport_number:'synthetic-passport'};
 const login={logged_customer_info:current,current_customer_info:current,token:{content:'synthetic',success:true}};
 const report={...detail(),show_print_corona_english_report:true,corona_t:'covid-time+',corona_hash:'covid%2Bhash'};
 // Regression: no request_id in the detail body; the eligible print branch must still run.
 expect('request_id' in report).toBe(false);
 const transport=new Transport([login,tests(),report,pdf()]);const readers=await MaccabiReaders.create(transport);
 await readers.getEnglishCovidLabReportPdf('request','doc');
 expect(transport.calls.at(-1)!.path).toContain('/labs/corona/Report?data=request&t=covid-time+&hash=covid%2Bhash');
 expect(transport.calls.at(-1)!.init?.apiAuthorization).toBe(false);
 expect(transport.calls.some(call=>call.init?.method==='PATCH')).toBe(false);
 expect(JSON.stringify(readers.getOwnerProfile())).not.toContain('synthetic-passport');
 const missing=new Transport([bootstrap()]);
 await expect((await MaccabiReaders.create(missing)).getEnglishCovidLabReportPdf('request','doc')).rejects.toMatchObject({code:'UNSUPPORTED_FLOW'});
 expect(missing.calls).toHaveLength(1);
 const ineligible=new Transport([login,tests(),{...report,show_print_corona_english_report:false}]);
 await expect((await MaccabiReaders.create(ineligible)).getEnglishCovidLabReportPdf('request','doc')).rejects.toMatchObject({code:'NOT_ELIGIBLE'});
 expect(ineligible.calls).toHaveLength(3);
});

test('comparison graph report uses the source numeric availability gate and exact graph flag',async()=>{
 const selection={source:'latest' as const,testId:'fixture-test'};
 const transport=new Transport([bootstrap(),latest(),comparison(),pdf()]);
 await(await MaccabiReaders.create(transport)).getLabComparisonPdf(selection,'graph');
 expect(new URL(transport.calls.at(-1)!.path,'https://synthetic.invalid').searchParams.get('is_graph')).toBe('true');
 const unavailable=comparison();for(const row of [unavailable.current_result,...unavailable.other_results]){row.max_lim=0;row.result=0;}
 const t=new Transport([bootstrap(),latest(),unavailable]);
 await expect((await MaccabiReaders.create(t)).getLabComparisonPdf(selection,'graph')).rejects.toMatchObject({code:'NOT_ELIGIBLE'});
 expect(t.calls).toHaveLength(3);
});

test('latest and individual reports forward only the source irregular-only option',async()=>{
 const latestTransport=new Transport([bootstrap(),latest(),pdf()]);
 await(await MaccabiReaders.create(latestTransport)).getLatestLabResultsPdf({irregularOnly:true});
 expect(new URL(latestTransport.calls.at(-1)!.path,'https://synthetic.invalid').searchParams.get('irregular_only')).toBe('true');
 const resultTransport=new Transport([bootstrap(),tests(),detail(),pdf()]);
 await(await MaccabiReaders.create(resultTransport)).getLabReportPdf('request','doc',{irregularOnly:true});
 expect(new URL(resultTransport.calls.at(-1)!.path,'https://synthetic.invalid').searchParams.get('irregular_only')).toBe('true');
 const invalid=new Transport([bootstrap()]);const readers=await MaccabiReaders.create(invalid);
 await expect(readers.getLatestLabResultsPdf({irregularOnly:'true' as any})).rejects.toBeInstanceOf(TypeError);
 expect(invalid.calls).toHaveLength(1);
});
