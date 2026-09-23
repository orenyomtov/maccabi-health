import * as z from "zod/v4";

/**
 * Row reference tokens.
 *
 * Every row a list tool returns carries a `ref`, and that token is the one handle a caller passes
 * to `maccabi_detail` and `maccabi_document`. It holds the row's kind together with every
 * identifier the reads behind that row need - a request id and its document id, a local reference
 * and the date range it was listed in, a report reference and its period. Because the pair travels
 * as one value, pairing an id from one row with an id from another is not expressible, which is the
 * mistake the ownership check used to catch after the fact. The raw identifiers stay in the row
 * exactly as before, for reading, logging and correlating against the CLI.
 *
 * The token is a pure function of the values inside it: no server state, no expiry, the same row
 * mints the same string on every list call. That matters for the HTTP transport, which builds a
 * fresh server instance per request, and for a caller whose conversation was compacted.
 *
 * It is opaque, not secret. It encodes identifiers that the same response already returns in the
 * clear, so it is not a capability and it carries nothing a caller did not already receive.
 */

const text = z.string().min(1).max(512);
const sha = z.string().regex(/^[a-f0-9]{64}$/, "Use the 64-character reference from the matching list result");
/** Same calendar rule the date arguments use, so a damaged range fails here rather than upstream. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine(value => {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, "Use a valid calendar date");
const ordered = <T extends { from?: string; to?: string }>(shape: z.ZodType<T>): z.ZodType<T> =>
  shape.refine(value => value.from === undefined || value.to === undefined || value.from <= value.to, "from must not be later than to");
const uid = z.string().min(1).max(64).regex(/^\d+(?:\.\d+)*$/, "Use a DICOM UID exactly as the imaging tools returned it");
const scalar = z.union([text, z.number()]);

/**
 * One entry per kind of row. The shape is exactly the arguments its downstream reads consume, so
 * decoding a token yields a ready selection rather than something that still needs assembling.
 */
export const REF_SHAPES = {
  test: z.object({ request_id: text, doc_id: text }),
  latest_labs: z.object({}),
  followed_labs: z.object({}),
  visit: z.object({ appointment_id: text }),
  inquiry: z.object({ request_id: text }),
  administrative_request: z.object({ interaction_id: text }),
  appointment: z.object({ reference: sha }),
  provider: z.object({ object_type: scalar, object_id: scalar, employee_id: scalar }),
  vaccination_group: z.object({ vaccine_group_code: z.number().int().min(0) }),
  prescription: z.object({ doc_id: text }),
  referral: z.object({ referral_id: text }),
  certificate: ordered(z.object({ reference: sha, from: day, to: day })),
  mailing: ordered(z.object({ from: day, to: day, reference: sha.optional() })),
  additional_information: ordered(z.object({ reference: sha, from: day, to: day })),
  hospital_report: ordered(z.object({ reference: sha, as_of: day, from: day.optional(), to: day.optional() })
    .refine(value => value.from === undefined === (value.to === undefined), "Provide both from and to, or neither")
    .refine(value => value.to === undefined || value.to <= value.as_of, "The range must end no later than as_of")),
  billing_report: z.object({ reference: sha, period: z.string().regex(/^\d{1,4}$/) }),
  nursing_insurance_report: z.object({ reference: sha }),
  imaging_study: z.object({ study_instance_uid: uid }),
  directory_provider: z.object({
    category: z.enum(["doctors", "labs-and-therapists"]),
    field: text,
    reference: z.string().regex(/^provider-[a-f0-9]{32}$/),
    city: text.optional(), name: z.string().min(1).max(200).optional(), page: z.number().int().min(1).max(1000).optional(),
  }),
} as const;

export type RefKind = keyof typeof REF_SHAPES;
export type RefPayload<K extends RefKind> = z.infer<(typeof REF_SHAPES)[K]>;
export const REF_KINDS = Object.keys(REF_SHAPES) as RefKind[];

const PREFIX = "mref1_";
/** Interpolated into nothing and parsed as JSON, so the bound is a schema rule rather than a later check. */
export const REF_TOKEN = z.string().regex(new RegExp(`^${PREFIX}[A-Za-z0-9_-]{2,3000}$`), "Use a `ref` value exactly as a list result returned it");

export class RefTokenError extends Error {}

export function encodeRef<K extends RefKind>(kind: K, payload: RefPayload<K>): string {
  const compact: Record<string, unknown> = {};
  // Sorted, so the same row mints the same token whatever order the caller's fields arrived in.
  for (const key of Object.keys(payload as Record<string, unknown>).sort()) {
    const value = (payload as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) compact[key] = value;
  }
  return PREFIX + Buffer.from(JSON.stringify([kind, compact])).toString("base64url");
}

export interface DecodedRef { kind: RefKind; payload: Record<string, string | number> }

export function decodeRef(token: string): DecodedRef {
  if (!token.startsWith(PREFIX)) throw new RefTokenError("That is not a row reference. Pass the `ref` value from a list result, copied exactly.");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(token.slice(PREFIX.length), "base64url").toString("utf8")); }
  catch { throw new RefTokenError("This ref is damaged. Re-run the list tool that produced the row and use the ref it returns now."); }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || !Object.hasOwn(REF_SHAPES, parsed[0])) {
    throw new RefTokenError("This ref does not name a row kind this server knows. Re-run the list tool that produced the row.");
  }
  const kind = parsed[0] as RefKind;
  const payload = REF_SHAPES[kind].safeParse(parsed[1]);
  if (!payload.success) throw new RefTokenError(`This ${kind} ref does not carry the identifiers that kind needs. Re-run the list tool that produced the row.`);
  return { kind, payload: payload.data as Record<string, string | number> };
}

/** Reads a token's kind without committing to its payload, for error text that names what was passed. */
export function refKind(token: string): RefKind | null {
  try { return decodeRef(token).kind; } catch { return null; }
}
