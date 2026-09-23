import { UpstreamError } from "./errors";

/** Fixed public display projection. It does not include booking links or opaque routing fields. */
export interface DirectoryProviderDetails {
  reference: string;
  Titel: string; First_Name: string; Last_Name: string; Service_Name: string;
  Full_Adress: string; City_Name: string; Street_Name: string; House_Number: string;
  Neighborhood: string; Posta: string; Relevnt_Populat: string; Referring_Text: string;
  Access: string; Age_Range_From: string; Age_Range_To: string; Treat_Area_String: string;
  Languages: string[];
  Treat_Areas: { TreatCode: string; TreatArea: string }[];
  ContactDetails: { Type: number; Title: string; Value: string; Code: string; IsDirectContact: boolean }[];
  Schedules: { Schedule_Type: string; Schedule_Desc: string; Schedule_Details: Record<string, string | null>[] }[];
  ResumeLines: Record<string, string>[];
  Treatments: { Sg_Treat_Name: string; Cpt_Pubt_Name: string; Is_Personal: string; Cpt_Code: string; Remark_Text: DirectoryRemark[] }[];
  remarks: Record<string, DirectoryRemark[]>;
}
export interface DirectoryRemark { Remark_Text: string; Line_Number: string; NewLine: boolean; Mlh: string }
const invalid = () => new UpstreamError("DIRECTORY_INVALID_RESPONSE");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_384) throw invalid();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw invalid(); return value; }
function array<T>(value: unknown, project: (value: unknown) => T, limit = 200): T[] {
  if (!Array.isArray(value) || value.length > limit) throw invalid();
  return value.map(project);
}
function strings(value: unknown, keys: readonly string[]): Record<string, string> {
  const row = object(value);
  return Object.fromEntries(keys.map(key => [key, string(row[key])]));
}
function remark(value: unknown): DirectoryRemark {
  const row = object(value);
  return { Remark_Text: string(row.Remark_Text), Line_Number: string(row.Line_Number), NewLine: boolean(row.NewLine), Mlh: string(row.Mlh) };
}
export function projectDirectoryDetails(value: unknown, reference: string): DirectoryProviderDetails {
  const row = object(value);
  const result = { reference, ...strings(row, ["Titel", "First_Name", "Last_Name", "Service_Name", "Full_Adress", "City_Name", "Street_Name", "House_Number", "Neighborhood", "Posta", "Relevnt_Populat", "Referring_Text", "Access", "Age_Range_From", "Age_Range_To", "Treat_Area_String"]) } as DirectoryProviderDetails;
  result.Languages = array(row.Languages, string);
  result.Treat_Areas = array(row.Treat_Areas, value => { const item = object(value); return { TreatCode: string(item.TreatCode), TreatArea: string(item.TreatArea) }; });
  result.ContactDetails = array(row.ContactDetails, value => {
    const item = object(value);
    if (typeof item.Type !== "number" || !Number.isSafeInteger(item.Type)) throw invalid();
    return { Type: item.Type, Title: string(item.Title), Value: string(item.Value), Code: string(item.Code), IsDirectContact: boolean(item.IsDirectContact) };
  }, 50);
  result.Schedules = array(row.Schedules, value => {
    const item = object(value);
    return { Schedule_Type: string(item.Schedule_Type), Schedule_Desc: string(item.Schedule_Desc), Schedule_Details: array(item.Schedule_Details, value => {
      const day = object(value);
      return { ...strings(day, ["Week_Day", "Week_Day_S", "Week_Day_L", "Shift_Start_H", "Shift_End_H", "Frequency_Desc", "Remark_Desc"]), Week_Day_Eng: day.Week_Day_Eng === null ? null : string(day.Week_Day_Eng) };
    }) };
  }, 50);
  result.ResumeLines = array(row.ResumeLines, value => strings(value, ["Resume_Topic", ...Array.from({ length: 7 }, (_, index) => [`Title${index + 1}`, `Title${index + 1}_Contents`]).flat()]));
  result.Treatments = array(row.Treatments, value => {
    const item = object(value);
    return { Sg_Treat_Name: string(item.Sg_Treat_Name), Cpt_Pubt_Name: string(item.Cpt_Pubt_Name), Is_Personal: string(item.Is_Personal), Cpt_Code: string(item.Cpt_Code), Remark_Text: array(item.Remark_Text, remark) };
  });
  result.remarks = {};
  for (const key of ["NameRemarks", "ContactRemarks", "DirectionRemarks", "GeneralRemarks", "NoticeRemarks", "ProfessionRemarks", "BoldComments"]) result.remarks[key] = array(row[key], remark);
  if (JSON.stringify(result).length > 256 * 1024) throw invalid();
  return result;
}
