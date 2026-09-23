import { expect, test } from "vitest";
import { MaccabiReaders, type ReadTransport } from "../src/readers";
import { projectNotificationPreferences } from "../src/readers/notification-preferences";

const owner = { member_id:123456789, member_id_code:"0", f_name_hebrew:"Fixture", l_name_hebrew:"Owner", f_name_english:"Fixture", l_name_english:"Owner", birth_date:"2000-01-01", sex:"synthetic" };
const bootstrap = () => ({session_id:"synthetic-navigation",logged_customer_info:owner,current_customer_info:owner,token:{success:true,content:"synthetic-token"}});
const page = (id = owner.member_id) => new Response(`<header><span id="ctl00_ctl00_wcSiteHeaderLobby1_wcSiteHeaderCurrentPatient_wcSiteHeaderChildrenList_lblCustomerIDNumber">${id}</span></header>`, {headers:{"content-type":"text/html; charset=utf-8"}});
const state = (code:number) => ({Code:code,Name:"Synthetic preference",Description:"Source description",IsRegistered:true,CanRegister:false,RestrictionDesc:"Source restriction",RestrictionCode:3,Order:1});
const preferences = () => ({ResultMessage:{Code:0},StatusCode:1,PreferredLangCode:7,ContactDetails:{CellPhone:"synthetic-phone",Email:"fixture@example.invalid"},MemberRegistrationDetails:{DeviceToken:"PRIVATE",UDID:"PRIVATE"},ServiceGroups:[{...state(100),Services:[{...state(7),TypeCode:null,DefaultChannelCode:1,ServiceChanneIdSelected:-1,IsMaccabitonType:false,Channels:[{...state(1),Description:null,RestrictionCode:null}]}]}]});
class Mock implements ReadTransport {
  calls:{path:string;init?:RequestInit & {apiAuthorization?:boolean}}[]=[];
  constructor(private queue:unknown[]){}
  setApiToken(){}
  async getOrCreatePortalNavigationSession(){return "synthetic-navigation";}
  async request(path:string|URL,init?:RequestInit & {apiAuthorization?:boolean}){this.calls.push({path:String(path),init});const value=this.queue.shift();return value instanceof Response?value:Response.json(value);}
}
test("preferences preserve persisted registration, channels, restrictions and contact without device or save metadata",async()=>{
  const t=new Mock([bootstrap(),page(),preferences()]);
  const result=await(await MaccabiReaders.create(t)).getNotificationPreferences();
  expect(result.data.groups[0]!.services[0]).toMatchObject({registered:true,canRegister:false,selectedChannelCode:-1,typeCode:null,channels:[{code:1,description:null,registered:true,canRegister:false}]});
  expect(result.data.contact.email).toBe("fixture@example.invalid");
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(t.calls[1]!.path).toContain("/online/directorship/personalreminders/?");
  expect(t.calls[2]).toEqual({path:"/online/webapi/PersonalRemindersESB/GetReminders/",init:{apiAuthorization:false}});
  expect(t.calls.every(call=>call.init?.method===undefined)).toBe(true);
});
test("preferences require a fresh owner page and exact JSON destination",async()=>{
  const mismatch=new Mock([bootstrap(),page(222222222),preferences()]);
  await expect((await MaccabiReaders.create(mismatch)).getNotificationPreferences()).rejects.toMatchObject({code:"OWNER_MISMATCH"});
  expect(mismatch.calls).toHaveLength(2);
  for(const url of ["https://example.invalid/other","https://online.maccabi4u.co.il/online/webapi/PersonalRemindersESB/GetReminders/?other=1"]){
    const response=Response.json(preferences());Object.defineProperty(response,"url",{value:url});
    const t=new Mock([bootstrap(),page(),response]);
    await expect((await MaccabiReaders.create(t)).getNotificationPreferences()).rejects.toMatchObject({code:"INVALID_RESPONSE"});
  }
});
test("preferences reject error envelopes, malformed state and duplicate codes",async()=>{
  const bad=preferences();bad.ResultMessage.Code=1;
  const t=new Mock([bootstrap(),page(),bad]);
  await expect((await MaccabiReaders.create(t)).getNotificationPreferences()).rejects.toMatchObject({code:"UPSTREAM_RESULT_ERROR"});
  const duplicate=preferences();duplicate.ServiceGroups.push(duplicate.ServiceGroups[0]!);
  expect(()=>projectNotificationPreferences(duplicate)).toThrow();
  const malformed=preferences() as unknown as Record<string,unknown>;malformed.ServiceGroups=[{...state(1),IsRegistered:"true",Services:[]}];
  expect(()=>projectNotificationPreferences(malformed)).toThrow();
  expect(()=>projectNotificationPreferences({Data:preferences()})).toThrow();
});
test("account access uses current owner fixed read, handles null users and omits private routing",async()=>{
  const t=new Mock([bootstrap(),{users:null,messages:[{type:"W-Warning",message:"Synthetic source message"}]}]);
  expect((await(await MaccabiReaders.create(t)).listAccountAccess()).data.users).toEqual([]);
  expect(t.calls[1]).toEqual({path:"/sonline/DirectorshipAPI/webapi/mac/v1/members/0/123456789/accounts",init:undefined});
  const populated=new Mock([bootstrap(),{users:[{first_name:"Fixture",last_name:"Delegate",user_id:"synthetic-visible-id",authentication_end_date:"2099-01-01",user_technical_id:"PRIVATE",patient_relation_id:"PRIVATE"}],messages:[{type:"S-Success",message:"Synthetic source message"}]}]);
  expect(JSON.stringify(await(await MaccabiReaders.create(populated)).listAccountAccess())).not.toContain("PRIVATE");
  const drift=new Mock([bootstrap(),{member_id:222222222,users:[]}]);
  await expect((await MaccabiReaders.create(drift)).listAccountAccess()).rejects.toMatchObject({code:"OWNER_MISMATCH"});
});
