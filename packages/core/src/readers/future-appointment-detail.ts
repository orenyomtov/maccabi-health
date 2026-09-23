import { projectFutureAppointments, type FutureAppointment } from "./future-appointments";

export interface FutureAppointmentInstruction {
  description: string;
  link: string | null;
}

export interface FutureAppointmentDetail {
  appointment: FutureAppointment;
  provider: {
    address: string | null;
    order_appointment_phone: string | null;
    phone: string | null;
    fax: string | null;
  };
  instructions: FutureAppointmentInstruction[];
}

export class FutureAppointmentDetailContentError extends Error {
  constructor() {
    super("Maccabi future appointment detail does not match the official frontend projection");
    this.name = "FutureAppointmentDetailContentError";
  }
}

const fail = (): never => { throw new FutureAppointmentDetailContentError(); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const optionalString = (value: unknown): string | null => value === undefined || value === null ? null : typeof value === "string" ? value : fail();
const instructionLink = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) fail();
  const link = value as string;
  let parsed: URL;
  try { parsed = new URL(link); } catch { return fail(); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) fail();
  return link;
};

/**
 * Fields rendered by the official normal-Maccabi future-appointment detail view.
 * Provider routing keys and every edit/cancel/upload control stay private. The frontend's
 * directly opened instruction URL is returned as read content but is never fetched here.
 */
export function projectFutureAppointmentDetail(appointmentValue: unknown, providerValue: unknown, instructionsValue: unknown): FutureAppointmentDetail {
  const appointment = projectFutureAppointments([appointmentValue])[0];
  if (!appointment) fail();

  const provider = record(providerValue);
  const details = record(provider.provider_details);
  if (!Array.isArray(provider.contacts) || provider.contacts.length > 100) fail();
  const contacts = provider.contacts as unknown[];
  const selectedContacts = new Map<string, string>();
  for (const raw of contacts) {
    const contact = record(raw);
    if (typeof contact.code !== "string") fail();
    const code = contact.code as string;
    if (!["01", "02", "03"].includes(code)) continue;
    const value = optionalString(contact.contact_details);
    if (value === null || selectedContacts.has(code)) fail();
    selectedContacts.set(code, value as string);
  }

  const instructions = record(instructionsValue);
  if (typeof instructions.visit_description !== "string" || instructions.visit_description.length === 0 || !Array.isArray(instructions.specific_visits_instructions) || instructions.specific_visits_instructions.length > 100) fail();
  const instructionRows = instructions.specific_visits_instructions as unknown[];
  const projectedInstructions = instructionRows.map(raw => {
    const instruction = record(raw);
    if (typeof instruction.description !== "string" || instruction.description.length === 0) fail();
    const description = instruction.description as string;
    return { description, link: instructionLink(instruction.link) };
  });

  const projected: FutureAppointmentDetail = {
    appointment,
    provider: {
      address: appointment.category_visit_type === 3 ? optionalString(details.full) : null,
      order_appointment_phone: selectedContacts.get("02") ?? null,
      phone: selectedContacts.get("01") ?? null,
      fax: selectedContacts.get("03") ?? null,
    },
    instructions: projectedInstructions,
  };
  if (Buffer.byteLength(JSON.stringify(projected)) > 128 * 1024) fail();
  return projected;
}
