import { describe, expect, test, vi } from 'vitest';
import { MaccabiReaders, type ReadTransport } from '../src/readers';

const owner = { member_id:123456789, member_id_code:'0', f_name_hebrew:'דוגמה', l_name_hebrew:'בדיקה', f_name_english:'Example', l_name_english:'Fixture', birth_date:'2000-01-01', sex:'synthetic' };
const bootstrap = () => ({logged_customer_info:owner,current_customer_info:owner,token:{content:'synthetic-token',success:true}});
const history = () => ({results:[{member_id:owner.member_id,member_id_code:'0',appointment_id:'fixture-visit',appointment_date:'original-date',service_provider_name:'Example clinician',service_name:'Example service',has_summery_file:true}]});
const signature = {timestamp:'time+value',hash:'signature%2F+'};
const detail = () => ({member_id:String(owner.member_id),member_id_code:'0',visit_summary_date:'original-date',service_provider_name:'Example clinician',visit_summary_pdf_link:'summary',...signature,
  drugs:[{drug_name:'תרופה לדוגמה',prescription_is_digital:1,rescription_cancellation_status:0,prescription_pdf_link:'prescription%2Fpath+value',...signature},{prescription_is_digital:1,rescription_cancellation_status:1,prescription_pdf_link:'cancelled',...signature}],
  referrals:[{referral_id:'fixture-referral',referral_description:'הפניה לדוגמה',referral_pdf_link:'referral%2Fpath+value',...signature}],
  approvals:[{title_name:'אישור לדוגמה',approval_pdf_link:'approval%2Fpath+value',...signature}],
  tutorials:[{type_id:1,item_display_text:'דף מידע',item_url:'information%2Fpath+value',...signature},{type_id:2,item_url:'https%3A%2F%2Fexample.invalid%2Fvideo',...signature},{type_id:3,item_url:'https%3A%2F%2Fexample.invalid%2Fguide',...signature}],
});
class Transport implements ReadTransport {
  calls: {path:string;init?:RequestInit & {apiAuthorization?:boolean}}[] = [];
  constructor(readonly responses: unknown[]) {}
  setApiToken() {}
  async request(input:string | URL,init?:RequestInit & {apiAuthorization?:boolean}) {
    this.calls.push({path:String(input),init});
    const value = this.responses.shift(); return value instanceof Response ? value : Response.json(value);
  }
}

describe('owner visit document PDFs', () => {
  test('projects source eligibility and local references without exposing signing or routing fields', async () => {
    const transport = new Transport([bootstrap(),history(),detail()]);
    const readers = await MaccabiReaders.create(transport);
    const data:any = (await readers.getVisit('fixture-visit')).data;
    for (const field of ['drugs','referrals','approvals','tutorials']) expect(data[field][0].pdf_reference).toMatch(/^[a-f0-9]{64}$/);
    expect(data.drugs[1].pdf_reference).toBeUndefined();
    expect(data.tutorials.slice(1).every((row:any) => row.pdf_reference === undefined)).toBe(true);
    expect(data.drugs[0].drug_name).toBe('תרופה לדוגמה');
    expect(data.tutorials[1].link).toBe('https://example.invalid/video');
    expect(data.tutorials[2].link).toBe('https://example.invalid/guide');
    for (const privateValue of ['%2Fpath','signature','time+value','item_url']) expect(JSON.stringify(data)).not.toContain(privateValue);
  });

  test.each(['drugs','referrals','approvals','tutorials'])('downloads only freshly resolved %s document with exact source encoding', async collection => {
    const transport = new Transport([bootstrap(),history(),detail()]);
    const readers = await MaccabiReaders.create(transport);
    const returned:any = (await readers.getVisit('fixture-visit')).data;
    const reference = returned[collection][0].pdf_reference;
    returned[collection][0].timestamp = 'caller-tampering';
    const fresh:any = detail(); fresh[collection][0].hash = 'rotated%2F+';
    transport.responses.push(history(),fresh,new Response('%PDF-synthetic-original',{headers:{'content-type':'application/pdf'}}));
    const pdf = await readers.getVisitDocumentPdf('fixture-visit',reference);
    expect(new TextDecoder().decode(pdf.data)).toBe('%PDF-synthetic-original');
    expect(transport.calls.at(-3)!.path).toContain('/visits/history');
    expect(transport.calls.at(-2)!.path).toContain('/visits/fixture-visit');
    const call = transport.calls.at(-1)!;
    const information = collection === 'tutorials';
    expect(call.path).toContain(information ? '/MedicalFileAPI/webapi/mac/v2/' : '/AppointmentOrderAPI/webapi/mac/v1/');
    expect(call.path).toContain(information ? '?url=' : '?path=');
    expect(call.path).toContain('%252Fpath%2Bvalue&timestamp=time+value&hash=rotated%2F+');
    expect(call.init?.apiAuthorization).toBe(false);
  });

  test('stale detail references and ambiguous or mismatched owner visits stop before PDF requests', async () => {
    const transport = new Transport([bootstrap(),history(),detail()]);
    const readers = await MaccabiReaders.create(transport);
    const data:any = (await readers.getVisit('fixture-visit')).data;
    const reference = data.referrals[0].pdf_reference;
    const changed = detail(); changed.referrals[0]!.referral_pdf_link = 'different-document';
    transport.responses.push(history(),changed);
    await expect(readers.getVisitDocumentPdf('fixture-visit',reference)).rejects.toMatchObject({code:'OWNER_MISMATCH'});
    const duplicate = history(); duplicate.results.push(duplicate.results[0]!);
    transport.responses.push(duplicate);
    await expect(readers.getVisitDocumentPdf('fixture-visit',reference)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    transport.responses.push(history(),{...detail(),member_id:'222222222'});
    await expect(readers.getVisitDocumentPdf('fixture-visit',reference)).rejects.toMatchObject({code:'OWNER_MISMATCH'});
    expect(transport.calls.every(call => !call.path.includes('/pdf?'))).toBe(true);
  });

  test('source gates remain enforced after refreshing a previously eligible prescription', async () => {
    const transport = new Transport([bootstrap(),history(),detail()]);
    const readers = await MaccabiReaders.create(transport);
    const data:any = (await readers.getVisit('fixture-visit')).data;
    const changed = detail(); changed.drugs[0]!.rescription_cancellation_status = 1;
    transport.responses.push(history(),changed);
    await expect(readers.getVisitDocumentPdf('fixture-visit',data.drugs[0].pdf_reference)).rejects.toMatchObject({code:'OWNER_MISMATCH'});
    expect(transport.calls.every(call => !call.path.includes('/pdf?'))).toBe(true);
  });
});

test('future appointment projection is owner-checked and explicitly source-derived', async () => {
  const row = {member_id:owner.member_id,member_id_code:'0',date:'original-date',provider_name:'Example clinician',provider_service_type:'Example service',permission_cancel:true,external_id:'private-routing'};
  const transport = new Transport([bootstrap(),[row],[{...row,member_id:222222222}]]);
  const readers = await MaccabiReaders.create(transport);
  const result = await readers.listFutureAppointments();
  expect(result.source.schemaEvidence).toBe('frontend-field-projection');
  expect(result.data[0]?.provider_name).toBe('Example clinician');
  expect(JSON.stringify(result)).not.toContain('private-routing');
  expect(JSON.stringify(result)).not.toContain('permission_cancel');
  await expect(readers.listFutureAppointments()).rejects.toMatchObject({code:'OWNER_MISMATCH'});
});

describe('future appointment detail reads', () => {
  const appointment = () => ({member_id:owner.member_id,member_id_code:'0',date:'original-date',provider_name:'Example clinician',provider_service_type:'Example service',category_visit_type:3,id:'private-appointment-id',object_type:'D',object_id:'private-object',employee_id:123,provider_id:456,type:3});
  const provider = () => ({providers:{provider:[{provider_details:{full:'כתובת מרפאה'},contacts:[{code:'01',contact_details:'טלפון מרפאה'}]}]}});
  const instructions = () => ({visit_description:'source gate',specific_visits_instructions:[{description:'הנחיה מקורית',link:null}]});

  test.each([false,true])('fresh owner list resolves provider/contact and instructions; fallback=%s', async fallback => {
    const row = appointment(); if (fallback) {row.employee_id = 0; row.object_type = 'O';}
    const transport = new Transport([bootstrap(),[row],[row],provider(),instructions()]);
    const readers = await MaccabiReaders.create(transport);
    const list = await readers.listFutureAppointments(); const reference = list.data[0]!.reference!;
    expect(reference).toMatch(/^[a-f0-9]{64}$/);
    list.data[0]!.date = 'caller-tampering';
    const result = await readers.getFutureAppointment(reference);
    expect(result.source.schemaEvidence).toBe('frontend-field-projection');
    expect(result.data.appointment.date).toBe('original-date');
    expect(result.data.provider.address).toBe('כתובת מרפאה');
    expect(result.data.instructions).toEqual([{description:'הנחיה מקורית',link:null}]);
    expect(JSON.parse(String(transport.calls.at(-2)!.init?.body))).toEqual({service_providers:[{object_type:row.object_type,object_id:row.object_id,...(fallback ? {provider_id:456} : {employee_id:123})}],retrieval_type:'1'});
    expect(JSON.parse(String(transport.calls.at(-1)!.init?.body))).toEqual({object_type:row.object_type,object_id:row.object_id,employee_id:row.employee_id,chosenVisitType:3});
    expect(transport.calls.at(-1)!.path).toContain('/appointments/instructions_for_visit_type');
    expect(transport.calls.every(call => !/odoro|cancel|summon|document_indication/.test(call.path))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  test('unknown, duplicate and changed appointment references never reach detail requests', async () => {
    const row = appointment();
    const transport = new Transport([bootstrap(),[row],[{...row,date:'different-date'}],[row,row]]);
    const readers = await MaccabiReaders.create(transport);
    const reference = (await readers.listFutureAppointments()).data[0]!.reference!;
    await expect(readers.getFutureAppointment(reference)).rejects.toMatchObject({code:'OWNER_MISMATCH'});
    await expect(readers.getFutureAppointment(reference)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    expect(transport.calls.every(call => !call.path.includes('/providers'))).toBe(true);
    const before = transport.calls.length;
    await expect(readers.getFutureAppointment('caller-url')).rejects.toMatchObject({code:'OWNER_MISMATCH'});
    expect(transport.calls.length).toBe(before);
  });
});


describe('owner general mailings', () => {
  const range = {from:'2025-01-01',to:'2026-01-01'};
  const mailing = () => ({member_id:owner.member_id,member_id_code:'0',letter_type:3,item_date:'date',original_item_date:'original-date',service_type_text:'שירות',practitioner_name:'דוגמה',tutorials:[{tutorial_type:'pdf',display_text:'מסמך',url:'private%2Ffile+',timestamp:'time+',hash:'signature%2B'},{tutorial_type:'webpage',display_text:'עמוד',url:'https://example.invalid'}]});
  test('projects only owner display fields and resolves a fresh tutorial PDF with source query semantics', async () => {
    const transport = new Transport([bootstrap(),{letters:[mailing(),{member_id:owner.member_id,member_id_code:'0',letter_type:2,status:1,item_date:'date',original_item_date:'date',link:'private-record',timestamp:'time'}]}]);
    const readers = await MaccabiReaders.create(transport);
    const list:any = await readers.listNotifications(range);
    const ref = list.data[0].tutorials[0].pdf_reference;
    expect(ref).toMatch(/^[a-f0-9]{64}$/);
    expect(list.data[1].has_document).toBe(true);
    expect(list.data[1].reference).toMatch(/^[a-f0-9]{64}$/);
    expect(list.data[0].tutorials[1].pdf_reference).toBeUndefined();
    expect(JSON.stringify(list)).not.toMatch(/private|signature|timestamp/);
    expect(list.source.schemaEvidence).toBe('frontend-field-projection');
    list.data[0].tutorials[0].url = 'tampered';
    const fresh = mailing(); fresh.tutorials[0]!.hash = 'rotated%2B';
    transport.responses.push({letters:[fresh]},new Response('%PDF-synthetic',{headers:{'content-type':'application/pdf'}}));
    await readers.getNotificationPdf(ref,range);
    expect(transport.calls.at(-1)!.path).toContain('/MainAppAPI/webapi/mac/v1/members/0/123456789/pdf/http?file_path=private%2Ffile+&timestamp=time+&hash=rotated%2B');
    expect(transport.calls.at(-1)!.init?.apiAuthorization).toBe(false);
  });
  test('rejects dependent, ambiguous, stale and unsafe tutorial selections before download', async () => {
    for (const changed of [{member_id:222222222},{recipient_id:222222222},{child_info:true}]) {
      const readers = await MaccabiReaders.create(new Transport([bootstrap(),{letters:[{...mailing(),...changed}]}]));
      await expect(readers.listNotifications(range)).rejects.toMatchObject({code:'OWNER_MISMATCH'});
    }
    const duplicate = await MaccabiReaders.create(new Transport([bootstrap(),{letters:[mailing(),mailing()]}]));
    await expect(duplicate.listNotifications(range)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    for (const changedPath of ['different','private%2Ffile+']) {
      const transport = new Transport([bootstrap(),{letters:[mailing()]}]);
      const readers = await MaccabiReaders.create(transport);
      const result:any = await readers.listNotifications(range);
      const fresh = mailing(); fresh.tutorials[0]!.url=changedPath; fresh.tutorials[0]!.hash='bad&selector=value';
      transport.responses.push({letters:[fresh]});
      await expect(readers.getNotificationPdf(result.data[0].tutorials[0].pdf_reference,range)).rejects.toMatchObject({code:changedPath==='different'?'OWNER_MISMATCH':'INVALID_RESPONSE'});
      expect(transport.calls.every(call=>!call.path.includes('/pdf/http'))).toBe(true);
    }
  });
});


describe('requested-record mailing PDFs',()=>{
 const range={from:'2025-01-01',to:'2026-01-01'};
 const mailing=()=>({member_id:owner.member_id,member_id_code:'0',letter_type:2,status:1,item_date:'date',original_item_date:'original-date',link:'private%2Frecord+',timestamp:'time+',hash:'signature%2B'});
 const features=(enabled:boolean)=>[{feature_id:'isOpenPdfByLinkHandlerV2',feature_enabled:enabled}];
 test.each([false,true])('uses current owner feature selection with correct authorization semantics, V2=%s',async enabled=>{
  const transport=new Transport([bootstrap(),{letters:[mailing()]},{letters:[mailing()]},features(enabled),new Response('%PDF-synthetic',{headers:{'content-type':'application/pdf'}})]);
  const readers=await MaccabiReaders.create(transport);
  const result=await readers.listNotifications(range);
  await readers.getNotificationPdf(result.data[0]!.reference as string,range);
  const call=transport.calls.at(-1)!;
  expect(call.path).toContain(`/MainAppAPI/webapi/mac/v${enabled?2:1}/members/0/123456789/pdf?file_path=private%2Frecord+&timestamp=time+`);
  expect(call.path.includes('&hash=signature%2B')).toBe(!enabled);
  expect(call.init?.apiAuthorization).toBe(enabled?undefined:false);
 });
 test('V2 polls only successful pending responses and stops after six attempts',async()=>{
  vi.useFakeTimers();
  try{
   const transport=new Transport([bootstrap(),{letters:[mailing()]},features(true),...Array.from({length:6},()=>new Response(null,{status:202}))]);
   const readers=await MaccabiReaders.create(transport);
   const reference=(await readers.listNotifications(range)).data[0]!.reference as string;
   transport.responses.unshift({letters:[mailing()]});
   const checked=expect(readers.getNotificationPdf(reference,range)).rejects.toMatchObject({code:'UPSTREAM_RESULT_ERROR'});
   await vi.runAllTimersAsync(); await checked;
   expect(transport.calls.filter(call=>call.path.includes('/v2/')&&call.path.includes('/pdf?'))).toHaveLength(6);
  }finally{vi.useRealTimers();}
 });
 test('HTTP failure, missing feature and lost eligibility stop before further attempts',async()=>{
  for(const response of [[],features(true)]){
   const transport=new Transport([bootstrap(),{letters:[mailing()]},response,new Response(null,{status:500})]);
   const readers=await MaccabiReaders.create(transport);
   const result=await readers.listNotifications(range);
   transport.responses.unshift({letters:[mailing()]});
   await expect(readers.getNotificationPdf(result.data[0]!.reference as string,range)).rejects.toMatchObject({code:response.length?'UPSTREAM_HTTP':'INVALID_RESPONSE'});
   expect(transport.calls.filter(call=>call.path.includes('/pdf?')).length).toBe(response.length?1:0);
  }
  const transport=new Transport([bootstrap(),{letters:[mailing()]}]);const readers=await MaccabiReaders.create(transport);
  const result=await readers.listNotifications(range);transport.responses.push({letters:[{...mailing(),status:0}]});
  await expect(readers.getNotificationPdf(result.data[0]!.reference as string,range)).rejects.toMatchObject({code:'OWNER_MISMATCH'});
  expect(transport.calls.some(call=>call.path.endsWith('/features'))).toBe(false);
 });
});

test('prescription status and permanent filters match source local predicates without dropping clinical fields',async()=>{
 const rows=Array.from({length:7},(_,index)=>({doc_id:`doc-${index+1}`,drug_name:'Example medicine',drug_instructions:'original instructions',from_date:'start',to_date:'end',purchase_status:index+1,is_permanent_drug:index%2===0,is_prescription_renewal:true,drug_largo_code:'12345',purchase_date:'source-date',price:12,dispensing:[{quantity:1}],file_link:'private',hash:'private',timestamp:'private'}));
 const cases:[any,number[]][]=[[{status:'valid'},[1,2,3,7]],[{status:'history'},[4,5,6]],[{status:'purchased'},[4,5]],[{status:'expired'},[6]],[{status:'renewable'},[4,5,6]],[{status:'history',permanent:true},[5]]];
 for(const [options,expected]of cases){
  const transport=new Transport([bootstrap(),{results:rows}]);
  const result=await(await MaccabiReaders.create(transport)).listPrescriptions(options);
  expect(result.data.map(row=>row.purchase_status)).toEqual(expected);
  expect(result.source.completeness).toBe('local-filtered-subset');
  expect(result.data[0]!.dispensing).toEqual([{quantity:1}]);
  expect(result.data[0]!.price).toBe(12);
  expect(result.data[0]!.medicine_info_link).toBe('https://www.maccabi4u.co.il/healthguide/medicines/תרופות/12345');
  expect(JSON.stringify(result)).not.toContain('private');
  expect(JSON.parse(String(transport.calls[1]!.init?.body))).toEqual({members:[{member_id_code:'0',member_id:owner.member_id}]});
 }
 const transport=new Transport([bootstrap()]);const readers=await MaccabiReaders.create(transport);
 await expect(readers.listPrescriptions({status:'unknown' as any})).rejects.toBeInstanceOf(TypeError);
 expect(transport.calls).toHaveLength(1);
});

describe('common administrative correspondence',()=>{
 const list=(classification='ServiceRequest')=>[{member_id:owner.member_id,member_id_code:'0',interaction_id:'fixture-request',classification,has_content:false}];
 const document=()=>({file_name:'מסמך',uri:'private%2Fdocument+',timestamp:'time+',hash:'signature%2B'});
 const detail=(classification:string)=>classification==='Case'?{messages:[{created_on:'date',body:'טקסט מקור',from_maccabi:true,documents:[document()]}],extended_properties:{unhandled:true}}:{body:'טקסט מקור',documents:[document()]};
 test.each(['Case','ServiceRequest'])('projects %s common content and resolves fresh owner document without mark-read',async classification=>{
  const transport=new Transport([bootstrap(),list(classification),detail(classification)]);const readers=await MaccabiReaders.create(transport);
  const result=await readers.getAdministrativeRequest('fixture-request');
  expect(result.data.coverage).toBe('common');
  expect(JSON.stringify(result)).not.toMatch(/private|signature|timestamp|unhandled/);
  const ref=result.data.attachments[0]!.reference;
  const fresh:any=detail(classification);(classification==='Case'?fresh.messages[0].documents:fresh.documents)[0].hash='rotated%2B';
  transport.responses.push(list(classification),fresh,new Response('%PDF-synthetic',{headers:{'content-type':'application/pdf'}}));
  await readers.getAdministrativeRequestPdf('fixture-request',ref);
  expect(transport.calls.at(-1)!.path).toContain('/RequestsAndApprovalsAPI/webapi/mac/v1/members/0/123456789/service_requests_document?doc_uri=private%2Fdocument+&timestamp=time+&hash=rotated%2B');
  expect(transport.calls.at(-1)!.init?.apiAuthorization).toBe(false);
  expect(transport.calls.some(call=>call.init?.method==='PUT')).toBe(false);
 });
 test('unknown/ambiguous owner requests, changed documents and nested owner mismatch stop before PDF',async()=>{
  for(const rows of [[],[...list(),...list()]]){
   const transport=new Transport([bootstrap(),rows]);
   await expect((await MaccabiReaders.create(transport)).getAdministrativeRequest('fixture-request')).rejects.toMatchObject({code:'OWNER_MISMATCH'});
   expect(transport.calls).toHaveLength(2);
  }
  const transport=new Transport([bootstrap(),list(),detail('ServiceRequest')]);const readers=await MaccabiReaders.create(transport);
  const first=await readers.getAdministrativeRequest('fixture-request');
  transport.responses.push(list(),{body:'text',documents:[{...document(),uri:'different'}]});
  await expect(readers.getAdministrativeRequestPdf('fixture-request',first.data.attachments[0]!.reference)).rejects.toMatchObject({code:'OWNER_MISMATCH'});
  transport.responses.push(list(),{body:'text',documents:[{...document(),member_id:222222222}]});
  await expect(readers.getAdministrativeRequest('fixture-request')).rejects.toMatchObject({code:'OWNER_MISMATCH'});
  expect(transport.calls.some(call=>call.path.includes('service_requests_document'))).toBe(false);
 });
});

test('medicine alternatives resolve fresh purchasable prescription and preserve only source modal fields',async()=>{
 const prescription=(status=1)=>({doc_id:'fixture-rx',drug_name:'Example',drug_instructions:'instruction',from_date:'start',to_date:'end',drug_largo_code:'12345',purchase_status:status});
 const transport=new Transport([bootstrap(),{results:[prescription()]},{drugs:[{largo_code:'67890',name:'חלופה לדוגמה',private_metadata:'omitted'}]}]);
 const result=await(await MaccabiReaders.create(transport)).listPrescriptionAlternatives('fixture-rx');
 expect(result.data).toEqual([{largo_code:'67890',name:'חלופה לדוגמה'}]);
 expect(result.source.schemaEvidence).toBe('frontend-field-projection');
 expect(transport.calls[2]!.path).toContain('/alternativeDrugs?largoCode=12345');
 for(const rows of [[],[prescription(),prescription()],[prescription(6)]]){
  const t=new Transport([bootstrap(),{results:rows}]);
  await expect((await MaccabiReaders.create(t)).listPrescriptionAlternatives('fixture-rx')).rejects.toMatchObject({code:rows.length===1?'UNSUPPORTED_FLOW':'OWNER_MISMATCH'});
  expect(t.calls).toHaveLength(2);
 }
});

test('administrative decision attachment refreshes its signatures and rejects decision owner drift',async()=>{
 const listed=[{member_id:owner.member_id,member_id_code:'0',interaction_id:'decision-request',classification:'Case'}];
 const detail=(hash:string,extra:Record<string,unknown>={})=>({messages:[],unified_status_code:51,extended_properties:{medication_approval:{approval_number:'approval',medication_name:'Example',print_document_title:'Decision',print_document_uri:'private%2Fdecision',timestamp:'time',hash,...extra}}});
 const transport=new Transport([bootstrap(),listed,detail('old')]);const readers=await MaccabiReaders.create(transport);
 const first=await readers.getAdministrativeRequest('decision-request');
 expect(first.data.decision?.medication?.medication_name).toBe('Example');
 transport.responses.push(listed,detail('rotated%2B'),new Response('%PDF-synthetic',{headers:{'content-type':'application/pdf'}}));
 await readers.getAdministrativeRequestPdf('decision-request',first.data.attachments[0]!.reference);
 expect(transport.calls.at(-1)!.path).toContain('doc_uri=private%2Fdecision&timestamp=time&hash=rotated%2B');
 transport.responses.push(listed,detail('hash',{member_id:222222222}));
 await expect(readers.getAdministrativeRequest('decision-request')).rejects.toMatchObject({code:'OWNER_MISMATCH'});
});

test('administrative feature-gated case documents use current owner flags and source eligibility',async()=>{
 const listed=[{member_id:owner.member_id,member_id_code:'0',interaction_id:'case',classification:'Case'}];
 const detail={messages:[],case_type_code:53,unified_status_code:91,documents:[{uri:'private%2Fcase',timestamp:'time',hash:'hash'}]};
 for(const enabled of [false,true]){
  const transport=new Transport([bootstrap(),listed,detail,[{feature_id:'EnablePartlyApprovedObligation',feature_enabled:enabled}]]);
  const result=await(await MaccabiReaders.create(transport)).getAdministrativeRequest('case');
  expect(result.data.attachments).toHaveLength(enabled?1:0);
  if(enabled)expect(result.data.attachments[0]!.file_name).toBeNull();
  expect(result.data.unsupported_sections).not.toContain('feature_gated_case_documents');
  expect(transport.calls[3]!.path.endsWith('/features')).toBe(true);
 }
 const malformed=new Transport([bootstrap(),listed,detail,[{feature_id:'IsCaseRejected',feature_enabled:'yes'}]]);
 await expect((await MaccabiReaders.create(malformed)).getAdministrativeRequest('case')).rejects.toMatchObject({code:'INVALID_RESPONSE'});
});

test('existing provider PDF is decoded only from fresh owner detail without payment or document requests',async()=>{
 const listed=[{member_id:owner.member_id,member_id_code:'0',interaction_id:'provider-case',classification:'Case'}];
 const detail=(base64:string)=>({messages:[],extended_properties:{obligation:{print_decision_type:'Print'}},provider_document:{last_doc_name_reviced:'Provider fixture',file_base64string:base64}});
 const encoded=btoa('%PDF-synthetic-provider');
 const transport=new Transport([bootstrap(),listed,detail(encoded)]);const readers=await MaccabiReaders.create(transport);
 const first=await readers.getAdministrativeRequest('provider-case');
 expect(JSON.stringify(first)).not.toContain(encoded);
 expect(first.data.unsupported_sections).not.toContain('provider_document');
 const ref=first.data.attachments[0]!.reference;
 transport.responses.push(listed,detail(encoded));
 expect(new TextDecoder().decode((await readers.getAdministrativeRequestPdf('provider-case',ref)).data)).toBe('%PDF-synthetic-provider');
 expect(transport.calls).toHaveLength(5);
 for(const invalid of [btoa('not-pdf'),'not base64']){
  transport.responses.push(listed,detail(invalid));
  await expect(readers.getAdministrativeRequestPdf('provider-case',ref)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
 }
 expect(transport.calls.some(call=>call.path.includes('/payment')||call.path.includes('service_requests_document'))).toBe(false);
});
