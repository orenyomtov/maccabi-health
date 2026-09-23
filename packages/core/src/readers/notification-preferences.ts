/** Current server settings only; unsaved browser edits and save payloads are excluded. */
export interface NotificationPreferenceState {
  code: number;
  name: string;
  description: string | null;
  registered: boolean;
  canRegister: boolean;
  restrictionDescription: string;
  restrictionCode: number | null;
  order: number;
}
export interface NotificationPreferenceService extends NotificationPreferenceState {
  typeCode: string | null;
  defaultChannelCode: number;
  selectedChannelCode: number;
  isMaccabitonType: boolean;
  channels: NotificationPreferenceState[];
}
export interface NotificationPreferenceGroup extends NotificationPreferenceState {
  services: NotificationPreferenceService[];
}
export interface NotificationPreferences {
  statusCode: number;
  preferredLanguageCode: number;
  contact: { cellPhone: string; email: string };
  groups: NotificationPreferenceGroup[];
}
export class NotificationPreferencesContentError extends Error {
  constructor() { super("Maccabi notification preferences do not match the observed response"); this.name = "NotificationPreferencesContentError"; }
}
const fail = (): never => { throw new NotificationPreferencesContentError(); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const text = (value: unknown): string => typeof value === "string" && value.length <= 16384 ? value : fail();
const number = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) ? value : fail();
const boolean = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const nullableText = (value: unknown): string | null => value === null ? null : text(value);
function list<T>(value: unknown, project: (row: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value) || value.length > 100) fail();
  const codes = new Set<number>();
  return (value as unknown[]).map(item => {
    const row = record(item), code = number(row.Code);
    if (codes.has(code)) fail();
    codes.add(code);
    return project(row);
  });
}
function state(row: Record<string, unknown>): NotificationPreferenceState {
  return {
    code: number(row.Code), name: text(row.Name), description: nullableText(row.Description),
    registered: boolean(row.IsRegistered), canRegister: boolean(row.CanRegister),
    restrictionDescription: text(row.RestrictionDesc),
    restrictionCode: row.RestrictionCode === null ? null : number(row.RestrictionCode), order: number(row.Order),
  };
}
/** Fixed groups/services/channels used by the official PersonalReminders controller. */
export function projectNotificationPreferenceGroups(value: unknown): NotificationPreferenceGroup[] {
  const groups = list(value, group => ({
    ...state(group),
    services: list(group.Services, service => ({
      ...state(service), typeCode: nullableText(service.TypeCode),
      defaultChannelCode: number(service.DefaultChannelCode), selectedChannelCode: number(service.ServiceChanneIdSelected),
      isMaccabitonType: boolean(service.IsMaccabitonType), channels: list(service.Channels, state),
    })),
  }));
  if (Buffer.byteLength(JSON.stringify(groups)) > 128 * 1024) fail();
  return groups;
}

export function projectNotificationPreferences(value: unknown): NotificationPreferences {
  const data = record(value);
  if (number(record(data.ResultMessage).Code) !== 0) fail();
  const contact = record(data.ContactDetails);
  const result = {
    statusCode: number(data.StatusCode), preferredLanguageCode: number(data.PreferredLangCode),
    contact: { cellPhone: text(contact.CellPhone), email: text(contact.Email) },
    groups: projectNotificationPreferenceGroups(data.ServiceGroups),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) fail();
  return result;
}
