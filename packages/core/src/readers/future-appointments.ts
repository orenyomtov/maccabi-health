export interface FutureAppointment {
  reference?: string;
  date: string;
  provider_name: string | null;
  provider_service_type: string;
  description: string | null;
  category_visit_type: number | null;
  ascribed_doctor: boolean | null;
  ascribed_doctor_gender: number | null;
  subsidiary_name: string | null;
  facility_category: string | null;
  follow_up_appointments_count: number | null;
  waiting_list_status: string | null;
  provider_role: string | null;
}

export class FutureAppointmentContentError extends Error {
  constructor() {
    super("Maccabi future appointment does not match the official frontend projection");
    this.name = "FutureAppointmentContentError";
  }
}

const fail = (): never => { throw new FutureAppointmentContentError(); };
const requiredString = (value: unknown): string => typeof value === "string" && value.length > 0 ? value : fail();
const optionalString = (value: unknown): string | null => value === undefined || value === null ? null : typeof value === "string" ? value : fail();
const optionalBoolean = (value: unknown): boolean | null => value === undefined || value === null ? null : typeof value === "boolean" ? value : fail();
const optionalInteger = (value: unknown, nonnegative = false): number | null => {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || nonnegative && (value as number) < 0) fail();
  return value as number;
};

/**
 * Fixed fields rendered by the official future-appointments timeline.
 * Routing identifiers, edit/cancel permissions and subsidiary-consent state stay private.
 */
export function projectFutureAppointments(value: unknown): FutureAppointment[] {
  if (!Array.isArray(value)) fail();
  const rows = value as unknown[];
  if (rows.length > 1000) fail();
  const projected = rows.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
    const row = raw as Record<string, unknown>;
    const subsidiaryName = optionalString(row.subsidiary_name);
    const providerName = optionalString(row.provider_name);
    if (subsidiaryName === null && (providerName === null || providerName.length === 0)) fail();
    const appointment: FutureAppointment = {
      date: requiredString(row.date),
      provider_name: providerName,
      provider_service_type: requiredString(row.provider_service_type),
      description: optionalString(row.description),
      category_visit_type: optionalInteger(row.category_visit_type),
      ascribed_doctor: optionalBoolean(row.ascribed_doctor),
      ascribed_doctor_gender: optionalInteger(row.ascribed_doctor_gender),
      subsidiary_name: subsidiaryName,
      facility_category: optionalString(row.facility_category),
      follow_up_appointments_count: optionalInteger(row.follow_up_appointments_count, true),
      waiting_list_status: optionalString(row.waiting_list_status),
      provider_role: optionalString(row.provider_role),
    };
    return appointment;
  });
  if (Buffer.byteLength(JSON.stringify(projected)) > 128 * 1024) fail();
  return projected;
}
