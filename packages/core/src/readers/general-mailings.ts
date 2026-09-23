export type GeneralMailing =
  | { letter_type: 1; letter_desc: string; item_date: string; original_item_date: string; has_document: true }
  | { letter_type: 2; status: 0 | 1 | 2 | 3; item_date: string; original_item_date: string; has_document: boolean }
  | { letter_type: 3; service_type_text: string; practitioner_name: string; item_date: string; original_item_date: string; tutorials: GeneralMailingTutorial[] };

export interface GeneralMailingTutorial {
  tutorial_type: "pdf" | "webpage" | "video";
  display_text: string;
  link?: string;
}

export class GeneralMailingContentError extends Error {
  constructor() {
    super("Maccabi mailing does not match the official frontend projection");
    this.name = "GeneralMailingContentError";
  }
}

const fail = (): never => { throw new GeneralMailingContentError(); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const text = (value: unknown): string => typeof value === "string" && value.length > 0 ? value : fail();
const externalLink = (value: unknown): string => {
  const link = text(value);
  if (link.length > 4096 || /[\u0000-\u001f\u007f]/.test(link)) fail();
  let parsed: URL;
  try { parsed = new URL(link); } catch { return fail(); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) fail();
  return link;
};

/**
 * Visible fields and attachment eligibility from Maccabi's three mailing branches.
 * Owner identifiers, PDF routes and signatures remain private. Web and video destinations
 * that the frontend opens directly are returned as read content but are never fetched here.
 */
export function projectGeneralMailings(value: unknown): GeneralMailing[] {
  if (!Array.isArray(value) || value.length > 1000) fail();
  const rows = value as unknown[];
  const projected = rows.map(raw => {
    const row = record(raw);
    const common = { item_date: text(row.item_date), original_item_date: text(row.original_item_date) };
    if (row.letter_type === 1) {
      text(row.reference_id); text(row.name_document); text(row.timestamp); text(row.hash);
      return { letter_type: 1 as const, letter_desc: text(row.letter_desc), ...common, has_document: true as const };
    }
    if (row.letter_type === 2) {
      if (!Number.isSafeInteger(row.status) || ![0, 1, 2, 3].includes(row.status as number)) fail();
      const status = row.status as 0 | 1 | 2 | 3;
      if (status === 1) {
        text(row.link); text(row.timestamp);
        if (row.hash !== undefined && row.hash !== null) text(row.hash);
      }
      return { letter_type: 2 as const, status, ...common, has_document: status === 1 };
    }
    if (row.letter_type === 3) {
      if (!Array.isArray(row.tutorials) || row.tutorials.length > 100) fail();
      const tutorials = (row.tutorials as unknown[]).map(rawTutorial => {
        const tutorial = record(rawTutorial);
        if (!(["pdf", "webpage", "video"] as unknown[]).includes(tutorial.tutorial_type)) fail();
        const tutorial_type = tutorial.tutorial_type as GeneralMailingTutorial["tutorial_type"];
        if (tutorial_type === "pdf") {
          text(tutorial.url); text(tutorial.timestamp); text(tutorial.hash);
          return { tutorial_type, display_text: text(tutorial.display_text) };
        }
        return { tutorial_type, display_text: text(tutorial.display_text), link: externalLink(tutorial.url) };
      });
      return { letter_type: 3 as const, service_type_text: text(row.service_type_text), practitioner_name: text(row.practitioner_name), ...common, tutorials };
    }
    return fail();
  });
  if (Buffer.byteLength(JSON.stringify(projected)) > 128 * 1024) fail();
  return projected;
}
