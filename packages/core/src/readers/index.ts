import { createHash } from "node:crypto";
import { discard, readCappedBody, readResponseBody, PORTAL_ORIGIN, type TransportRequestInit } from "../transport";
import { ReauthenticationRequired, ISSUES_URL } from "../errors";
import { assertLegacyPageOwner, parseLegacyHospitalSettings, parseLegacyRecommendations, parseLegacySelectedSummary, LegacyContentError, LegacyOwnerMismatchError, type LegacyRecommendations, type LegacySelectedSummary } from "./legacy";
export type { LegacyRecommendations, LegacySelectedSummary } from "./legacy";
import { parseBillingPeriods, parseQuarterlyBillingRows, parseQuarterlyBillingDocuments, type QuarterlyBillingCatalog } from "./billing";
export type { QuarterlyBillingCatalog, BillingPeriod } from "./billing";
import { parseNursingInsuranceRows, parseNursingInsuranceDocuments, type NursingInsuranceCatalog } from "./nursing-billing";
export type { NursingInsuranceCatalog } from "./nursing-billing";
import { projectFutureAppointments, FutureAppointmentContentError, type FutureAppointment } from "./future-appointments";
export type { FutureAppointment } from "./future-appointments";
import { projectFutureAppointmentDetail, FutureAppointmentDetailContentError, type FutureAppointmentDetail } from "./future-appointment-detail";
export type { FutureAppointmentDetail } from "./future-appointment-detail";
import { projectGeneralMailings, GeneralMailingContentError } from "./general-mailings";
import { projectAdministrativeDetail, AdministrativeDetailContentError, type AdministrativeDetail, type PrivateAdministrativeDocument, type AdministrativeFeatureContext } from "./administrative-detail";
export type { AdministrativeDetail } from "./administrative-detail";
import { projectLatestLabResults, projectLabComparison, projectFollowedLabResults, LatestLabResultContentError, type LatestLabResultGroup, type LabComparison, type FollowedLabResults } from "./latest-lab-results";
export type { LatestLabResultGroup, LatestLabResult, LabComparison, FollowedLabResults } from "./latest-lab-results";
import { projectAccountAccess, AccountAccessContentError, type AccountAccess } from "./account-access";
export type { AccountAccess, AccountAccessUser } from "./account-access";
import { projectNotificationPreferences, NotificationPreferencesContentError, type NotificationPreferences } from "./notification-preferences";
export type { NotificationPreferences, NotificationPreferenceGroup, NotificationPreferenceService, NotificationPreferenceState } from "./notification-preferences";
import { projectInquiryClinicalRequests, InquiryClinicalRequestContentError } from "./inquiry-detail";
import { handoffPath, openImagingViewer, readImageMetadata, readImagePixels, readImageThumbnail, readStudyStructure, ImagingViewerError, type ImagingImageMetadata, type ImagingPixels, type ImagingStudyStructure, type ImagingViewerSession } from "./imaging-viewer";
export type { ImagingImageMetadata, ImagingInstance, ImagingPixelGeometry, ImagingPixels, ImagingSeries, ImagingStudyStructure, ImagingViewerSession } from "./imaging-viewer";
/** Observed owner-only read operations. Public evidence index: docs/API-SOURCES.md. */
export interface ReadTransport {
  request(input: string | URL, init?: TransportRequestInit): Promise<Response>;
  setApiToken(token: string): void;
  getOrCreatePortalNavigationSession?(owner: OwnerIdentity, bootstrapSessionId: string): Promise<string>;
}
export type SourceRecord = Record<string, unknown>;
type AppointmentDocument = { path: string; timestamp: unknown; hash: unknown; informationSheet: boolean };
export interface OwnerIdentity { memberId: number; memberIdCode: string }
export interface ReadResult<T> {
  data: T;
  retrievedAt: string;
  source: { service: string; operation: string; completeness: "upstream-response" | "local-filtered-subset"; schemaEvidence?: "frontend-field-projection"; scope?: "payer-account-aggregate"; selection?: { mode: "local"; field: "execute_date"; year: number } };
}
export interface Prescription extends SourceRecord {
  doc_id: string;
  drug_name: string;
  drug_instructions: string;
  from_date: string;
  to_date: string;
}
export interface PrescriptionListOptions {
  status?: "all" | "valid" | "history" | "purchased" | "expired" | "renewable";
  permanent?: boolean;
}
export interface Referral extends SourceRecord {
  referral_id: string;
  referral_date: string;
  displaying_name: string;
  pdf_link: string;
}
export interface ProviderReference { object_type: string; object_id: string; employee_id: string }
export interface RecentProvider extends SourceRecord, ProviderReference { pactitioner_name_title: string; practitioner_id: string; clinic_address: SourceRecord }
export interface ClinicAvailability { months: { view_month: string; first_month: string; last_month: string }; days: { dayDate: string; times: string[] }[]; messages: string[]; mode: "clinic" }
export interface VisitSummary extends SourceRecord {
  appointment_id: string; appointment_date: string; service_provider_name: string; service_name: string; has_summery_file: boolean;
}
export interface DateRange { from: string; to: string }
export type LabTestSelection =
  | { source: "result"; requestId: string; docId: string; testId: string }
  | { source: "latest" | "followed"; testId: string };
export interface LabReportOptions { irregularOnly?: boolean }
export interface VaccinationGroup extends SourceRecord {
  vaccine_group_code: number; vaccinations_amount: number; vaccine_group_name: string; first_date: string; last_date: string; timestamp: string;
}
export interface Inquiry extends SourceRecord { request_id: string; type: string; service_provider_name: string; request_status: string; status_update_date: string }
export interface MedicalCertificate extends SourceRecord { reference: string; title_name: string; practitioner_full_name: string; specialization_description: string; approval_date: string; approval_date_from: string; approval_date_to: string; approval_type_code: string }
export interface TestListOptions { year?: number }
export interface TestSummary extends SourceRecord {
  request_id: string; doc_id: string; type: string; execute_date: string; result_date: string; test_name: string[];
  /** Derived, not from the source: the row carries an attached document that the PDF read can fetch. */
  has_document: boolean;
}
export interface LabResult extends SourceRecord {
  results: (SourceRecord & { group_name: string; group_values: SourceRecord[] })[];
  execute_date: string;
  is_partial: boolean;
}
export interface OwnerProfile {
  member_id: number;
  member_id_code: string;
  f_name_hebrew: string;
  l_name_hebrew: string;
  f_name_english: string;
  l_name_english: string;
  birth_date: string;
  sex: string;
}
export type ReadErrorCode = "UPSTREAM_HTTP" | "INVALID_RESPONSE" | "OWNER_MISMATCH" | "DEPENDENT_SELECTED" | "TOKEN_UNAVAILABLE" | "UPSTREAM_RESULT_ERROR" | "UNSUPPORTED_FLOW" | "NOT_ELIGIBLE";
export class ReadOperationError extends Error {
  constructor(readonly code: ReadErrorCode, readonly operation: string, readonly status?: number) {
    super(`Maccabi ${operation}: ${code}${status === undefined ? "" : ` (${status})`}`);
    this.name = "ReadOperationError";
  }
  /** The same text the CLI prints and the MCP surface returns, so a library caller need not know the map exists. */
  get guidance(): string { return READ_ERROR_GUIDANCE[this.code](this.operation); }
}
/**
 * What a caller should actually do about each read failure. The codes mean very different things - a
 * retry is right for UPSTREAM_HTTP and wrong for INVALID_RESPONSE - so every code gets its own message
 * and every message names the operation that failed, which is the only way to tell "recent providers
 * needs an adult account" apart from "that reference is stale".
 *
 * Only the three codes that mean a defect or a missing branch in this client carry the issue link. A
 * stale reference, a selected dependent or a failing portal are not this project's bugs, and putting
 * the link on those would train a caller to ignore it exactly where it matters.
 */
export const READ_ERROR_GUIDANCE: Record<ReadErrorCode, (operation: string) => string> = {
  UPSTREAM_HTTP: operation => `Maccabi returned an HTTP error for the ${operation} read. This is an upstream failure, not a bad argument. Retry once with the same arguments; if it repeats, stop and tell the member the portal is failing.`,
  UPSTREAM_RESULT_ERROR: operation => `Maccabi reported an error inside an otherwise valid ${operation} response. Retry once with the same arguments; if it repeats, stop and report it.`,
  TOKEN_UNAVAILABLE: operation => `The ${operation} read needed a session token the portal did not supply. Renew the session, then retry once. Do not change the arguments.`,
  INVALID_RESPONSE: operation => `Maccabi's ${operation} response did not match any shape this client parses. This is a gap in this client, not a bad argument. Do not retry and do not vary the arguments — report the read as unsupported, and tell the member it is worth an issue at ${ISSUES_URL}, naming the operation and never pasting clinical data.`,
  OWNER_MISMATCH: operation => `The supplied reference or id is not in this owner's current ${operation} data. It is stale, or it came from a different row or a different list. Re-run the originating list and use a reference from the fresh response. Do not reuse the old one, and do not combine ids taken from two different rows.`,
  DEPENDENT_SELECTED: operation => `The ${operation} read found a different member selected in the Maccabi portal, so the logged-in member and the currently viewed one differ. The session is fine and no new login is needed: switch the portal back to the logged-in member, then retry. Do not sign in again and do not remove the saved session.`,
  UNSUPPORTED_FLOW: operation => `This row belongs to the owner but the source has no ${operation} for it, or this account does not qualify for the flow at all (recent providers, for example, require an adult account). Do not retry with the same input. Choose a different row, a different document variant, or a different tool. If the portal itself does offer this, supporting it is a missing feature: ${ISSUES_URL}.`,
  NOT_ELIGIBLE: operation => `The source says this owner or this row is not eligible for the ${operation} branch. This is a real negative answer, not a transient failure. Do not retry; tell the member the document is not available to them. If the portal does show it to them, that contradiction is a defect worth reporting at ${ISSUES_URL}.`,
};
function object(value: unknown, operation: string): SourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReadOperationError("INVALID_RESPONSE", operation);
  return value as SourceRecord;
}
function string(value: unknown, operation: string): string {
  if (typeof value !== "string") throw new ReadOperationError("INVALID_RESPONSE", operation);
  return value;
}
/**
 * Whether the source attached a document to a test row. The row's type is the wrong thing to ask: the
 * list carries types this client has never seen, and each of them reports its own documents in this
 * same field. The download keys on doc_id, so the field is read for presence only, never as a path.
 */
function hasSourceDocument(record: SourceRecord): boolean {
  return Array.isArray(record.result_files) && record.result_files.some(entry => {
    const file = !!entry && typeof entry === "object" ? (entry as SourceRecord).result_file : undefined;
    // A blank path is the source saying there is nothing attached; without the trim a single space would
    // pass the gate and send a real download request for a document that does not exist.
    return typeof file === "string" && file.trim() !== "";
  });
}
function decodeSourceQueryComponent(value: unknown, operation: string): string {
  try { return decodeURIComponent(string(value, operation)); }
  catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
}
function decodePdfEnvelope(data: SourceRecord, operation: string): Uint8Array {
  if (data.type !== "pdf") throw new ReadOperationError("INVALID_RESPONSE", operation);
  return decodeBase64Pdf(data.base64, operation);
}
function decodeBase64Pdf(base64: unknown, operation: string): Uint8Array {
  if (typeof base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new ReadOperationError("INVALID_RESPONSE", operation);
  let bytes: Uint8Array;
  try { const decoded = atob(base64); if (btoa(decoded) !== base64) throw new Error(); bytes = Uint8Array.from(decoded, c => c.charCodeAt(0)); } catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new ReadOperationError("INVALID_RESPONSE", operation);
  return bytes;
}
function identity(value: unknown, operation: string): OwnerIdentity {
  const data = object(value, operation);
  if (!Number.isSafeInteger(data.member_id) || (data.member_id as number) < 0 || typeof data.member_id_code !== "string" || !/^\d+$/.test(data.member_id_code)) {
    throw new ReadOperationError("INVALID_RESPONSE", operation);
  }
  return { memberId: data.member_id as number, memberIdCode: data.member_id_code };
}
function validateDateRange(range: DateRange): void {
  for (const date of [range.from, range.to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new TypeError("Dates must be valid YYYY-MM-DD values");
  }
  if (range.from > range.to) throw new TypeError("from must not be later than to");
}
function sameOwner(a: OwnerIdentity, b: OwnerIdentity): boolean {
  return a.memberId === b.memberId && a.memberIdCode === b.memberIdCode;
}
function assertRecordOwner(row: SourceRecord, owner: OwnerIdentity, operation: string): void {
  if ((row.member_id !== undefined && String(row.member_id) !== String(owner.memberId)) ||
      (row.member_id_code !== undefined && String(row.member_id_code) !== owner.memberIdCode)) {
    throw new ReadOperationError("OWNER_MISMATCH", operation);
  }
}
/**
 * F5 BIG-IP APM answers an expired session on the portal origin with its own logon/logout page. The
 * shape we measured is a 302 to `/my.policy`, which the transport catches one hop earlier, but the
 * hop after it is a 200 `text/html` F5 page - so if F5 ever serves that page directly, without the
 * redirect, a JSON read lands here. Only a page that carries an F5 marker is read as an expiry;
 * any other HTML is still a parsing gap, which is a different answer for the caller.
 */
const F5_LOGON_PAGE = /\bF5\b|my\.policy|my\.logout\.php3/i;
/**
 * The ceiling on every original PDF this client will read, and the size at which the read is aborted
 * mid-stream rather than measured after the fact. It matches the MCP layer's own PDF_LIMIT, so a
 * document this refuses could not have been returned to a model anyway.
 */
const PDF_BYTE_LIMIT = 2 * 1024 * 1024;
async function json(transport: ReadTransport, path: string, operation: string, init?: RequestInit): Promise<unknown> {
  const response = await transport.request(path, init);
  if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
  if (response.headers.get("content-type")?.toLowerCase().includes("html")) {
    const page = await readResponseBody(() => response.text(), new ReadOperationError("INVALID_RESPONSE", operation));
    if (F5_LOGON_PAGE.test(page.slice(0, 8192))) throw new ReauthenticationRequired(response.status);
    throw new ReadOperationError("INVALID_RESPONSE", operation);
  }
  // Do not put upstream bodies, URLs, tokens, or personal values into errors.
  return readResponseBody(() => response.json(), new ReadOperationError("INVALID_RESPONSE", operation));
}

/** Only observed legacy wire encodings; absent charset uses strict UTF-8 and never replacement decoding. Modern API JSON remains UTF-8. */
async function legacyBody(response: Response, operation: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  const declarations = [...contentType.matchAll(/;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/gi)];
  if (declarations.length > 1) { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
  const charset = (declarations[0]?.[1] ?? declarations[0]?.[2] ?? "utf-8").toLowerCase();
  if (charset !== "utf-8" && charset !== "windows-1255") { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
  const bytes = await readCappedBody(response, 1024 * 1024, new ReadOperationError("INVALID_RESPONSE", operation));
  try { return new TextDecoder(charset, { fatal: true }).decode(bytes); }
  catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
}

export class MaccabiReaders {
  private readonly quarterlyBillingDocuments = new Map<string, { token: string; reportType: string }>();
  private readonly nursingInsuranceDocuments = new Map<string, { token: string; reportType: string }>();
  private readonly administrativeDocuments = new Map<string, Map<string, PrivateAdministrativeDocument>>();
  private readonly prescriptionReferences = new Map<string, SourceRecord[]>();
  private readonly notificationReferences = new Map<string, SourceRecord>();
  private notificationRange?: string;
  private readonly informationReferences = new Map<string, SourceRecord>();
  private informationRange?: string;
  private readonly testReferences = new Map<string, SourceRecord>();
  private readonly labDetails = new Map<string, SourceRecord>();
  private latestLabMetadata?: SourceRecord;
  private followedLabMetadata?: SourceRecord;
  private readonly vaccinationGroupReferences = new Set<number>();
  private readonly visitReferences = new Set<string>();
  private readonly visitPdfRecords = new Map<string, SourceRecord>();
  private readonly visitDocumentRecords = new Map<string, Map<string, AppointmentDocument>>();
  private readonly futureAppointmentRecords = new Map<string, SourceRecord>();
  private readonly inquiryDocumentRecords = new Map<string, Map<string, AppointmentDocument>>();
  private readonly inquiryListedDocuments = new Map<string, {reference:string;document:AppointmentDocument}>();
  private readonly certificateReferences = new Map<string, SourceRecord>();
  private readonly hospitalReferences = new Map<string, SourceRecord>();
  private hospitalReferenceSelection?: string;
  private readonly inquiryReferences = new Map<string, Inquiry>();
  private readonly referralReferences = new Map<string, Referral>();
  private readonly providerReferences = new Map<string, RecentProvider>();
  #appointmentAuthentication?: string;
  private readonly ownerRetrievedAt = new Date().toISOString();
  /**
   * One viewer session per study, for the lifetime of this reader. The handoff token is minted per
   * click and the capture says nothing about whether a session may be reused for a study it was not
   * handed, so a second study runs the whole chain again rather than gambling on the first one.
   */
  readonly #imagingViewers = new Map<string, ImagingViewerSession>();
  /**
   * The member's per-member checksum, the fourth input of the imaging handoff URL. It is not
   * per-study and it authorises every study the member has, so it is held privately and is never
   * returned, logged or put into a URL any caller sees.
   */
  #checksumId?: string;
  private constructor(private readonly transport: ReadTransport, private readonly owner: OwnerIdentity, private readonly profile: OwnerProfile, private readonly appointmentOwnerData: SourceRecord) {}

  /** Loads the logged-in owner. Rejects a selected dependent and does not expose family data. */
  static async create(transport: ReadTransport, expectedOwner?: OwnerIdentity): Promise<MaccabiReaders> {
    const operation = "account";
    const data = object(await json(transport, "/sonline/TokenServerAPI/webapi/mac/v4/members/token/full?checksum=&sr_id=", operation), operation);
    const logged = identity(data.logged_customer_info, operation);
    const current = identity(data.current_customer_info, operation);
    // A dependent selected in the portal is a live session viewing someone else, not a dead one, so it
    // gets its own code; only the saved owner differing from the logged-in one stays OWNER_MISMATCH.
    if (!sameOwner(logged, current)) throw new ReadOperationError("DEPENDENT_SELECTED", operation);
    if (expectedOwner && !sameOwner(logged, expectedOwner)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const token = object(data.token, operation);
    if (token.success !== true || typeof token.content !== "string" || token.content.length === 0) throw new ReadOperationError("TOKEN_UNAVAILABLE", operation);
    const rawProfile = object(data.logged_customer_info, operation);
    const currentProfile = object(data.current_customer_info, operation);
    const profile: OwnerProfile = {
      member_id: logged.memberId, member_id_code: logged.memberIdCode,
      f_name_hebrew: string(rawProfile.f_name_hebrew, operation), l_name_hebrew: string(rawProfile.l_name_hebrew, operation),
      f_name_english: string(rawProfile.f_name_english, operation), l_name_english: string(rawProfile.l_name_english, operation),
      birth_date: string(rawProfile.birth_date, operation), sex: string(rawProfile.sex, operation),
    };
    transport.setApiToken(token.content);
    const readers = new MaccabiReaders(transport, logged, profile, { hasEnglishReportIdentity: Boolean(currentProfile.f_name_english && currentProfile.l_name_english && currentProfile.passport_number), age: structuredClone(rawProfile.age), phones: structuredClone(rawProfile.phones), hasOtherPayer: typeof rawProfile.pays_id === "number" ? rawProfile.pays_id !== logged.memberId : undefined, legacySessionId: typeof data.session_id === "string" ? data.session_id : undefined, contact: { email: structuredClone(rawProfile.email), phones_update_date: structuredClone(rawProfile.phones_update_date), addresses: structuredClone(rawProfile.addresses) } });
    // Read here rather than at use, because it lives on the same bootstrap every session already
    // makes. Absent is not a failure of this call - only the imaging handoff needs it.
    if (typeof currentProfile.checksum_id === "string" && currentProfile.checksum_id) readers.#checksumId = currentProfile.checksum_id;
    return readers;
  }
  get currentOwner(): OwnerIdentity { return { ...this.owner }; }
  getOwnerProfile(): ReadResult<OwnerProfile> { return { ...this.result({ ...this.profile }, "TokenServerAPI", "account"), retrievedAt: this.ownerRetrievedAt }; }

  /** Existing access to the logged-in owner's account; does not grant, extend or revoke access. */
  async listAccountAccess(): Promise<ReadResult<AccountAccess>> {
    const operation = "account-access";
    const data = object(await json(this.transport, this.path("DirectorshipAPI", "v1", "accounts"), operation), operation);
    assertRecordOwner(data, this.owner, operation);
    try {
      const result = this.result(projectAccountAccess(data), "DirectorshipAPI", operation);
      return { ...result, source: { ...result.source, schemaEvidence: "frontend-field-projection" } };
    } catch (error) {
      if (error instanceof AccountAccessContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
  }

  /** One ordinary owner keep-alive request. Does not promise a duration or override forced expiry. */
  async renewSession(): Promise<ReadResult<{ renewed: true }>> {
    const operation = "session-renewal";
    const response = await this.transport.request(this.path("MainAppAPI", "v1", "alive"));
    if (response.status !== 200) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    const body = await readResponseBody(() => response.text(), new ReadOperationError("INVALID_RESPONSE", operation));
    if (body !== "") throw new ReadOperationError("INVALID_RESPONSE", operation);
    return this.result({ renewed: true }, "MainAppAPI", operation);
  }

  /** Owner contact details already supplied by the authenticated account bootstrap; no lookup or update. */
  getOwnerContactProfile(): ReadResult<SourceRecord> {
    const operation = "contact-profile";
    const contact = object(this.appointmentOwnerData.contact, operation);
    const phones = this.rows(this.appointmentOwnerData.phones, operation).map(row => {
      if (typeof row.phone_no !== "number" || !Number.isSafeInteger(row.phone_no) || row.phone_no < 0) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return { phone_type: string(row.phone_type, operation), phone_prefix: string(row.phone_prefix, operation), phone_no: row.phone_no, fax_special_prefix: string(row.fax_special_prefix, operation) };
    });
    const addresses = this.rows(contact.addresses, operation).map(row => {
      const selected: SourceRecord = {};
      for (const field of ["address_status", "address_type", "postal_code", "city_name", "street_name", "house_num", "entrance", "apartment_num", "zip_code", "address_for_mail", "city_name_for_not_maccabi_member", "street_name_for_not_maccabi_member"]) selected[field] = string(row[field], operation);
      if (typeof row.po_box !== "number" || !Number.isSafeInteger(row.po_box) || row.po_box < 0) throw new ReadOperationError("INVALID_RESPONSE", operation);
      selected.po_box = row.po_box;
      return selected;
    });
    return { ...this.result({ email: string(contact.email, operation), phones_update_date: string(contact.phones_update_date, operation), phones, addresses }, "TokenServerAPI", operation), retrievedAt: this.ownerRetrievedAt };
  }

  /** Owner mailings with source-derived references for eligible original documents. */
  async listNotifications(range: DateRange): Promise<ReadResult<SourceRecord[]>> {
    validateDateRange(range);
    const operation = "notifications";
    const data = object(await json(this.transport, this.path("DirectorshipAPI", "v1", "all/letters_for_member"), operation, this.post({ from_date: range.from, to_date: range.to, members: [this.member()] })), operation);
    const references = new Map<string, SourceRecord>();
    const rows = this.rows(data.letters, operation).map(row => {
      if (String(row.member_id) !== String(this.owner.memberId) || String(row.member_id_code) !== this.owner.memberIdCode) throw new ReadOperationError("OWNER_MISMATCH", operation);
      const recipientPresent = row.recipient_id !== undefined || row.recipient_id_code !== undefined;
      if ((row.letter_type === 1 || recipientPresent) && (String(row.recipient_id) !== String(this.owner.memberId) || String(row.recipient_id_code) !== this.owner.memberIdCode)) throw new ReadOperationError("OWNER_MISMATCH", operation);
      if (row.child_info === true) throw new ReadOperationError("OWNER_MISMATCH", operation);
      // A type-1 mailing that never says whose it is has not been shown to belong to someone else -
      // the field this reader needs simply is not there. `notifications` takes no reference, so the
      // OWNER_MISMATCH guidance would tell the caller to re-run a list with a fresh reference it has
      // no way to supply; the honest answer is that this response shape is not one we parse.
      if (row.letter_type === 1 && row.child_info !== false) throw new ReadOperationError("INVALID_RESPONSE", operation);
      if (row.letter_type === 2 || row.letter_type === 3) {
        try {
          const projected = projectGeneralMailings([row])[0]!;
          if (projected.letter_type === 3) {
            const tutorials = row.tutorials as SourceRecord[];
            return { ...projected, tutorials: projected.tutorials.map((tutorial, index) => {
              if (tutorial.tutorial_type !== "pdf") return tutorial;
              const privateTutorial = tutorials[index]!;
              const reference = createHash("sha256").update(JSON.stringify([row.item_date, row.original_item_date, row.service_type_text, index, privateTutorial.url])).digest("hex");
              if (references.has(reference)) throw new ReadOperationError("INVALID_RESPONSE", operation);
              references.set(reference, structuredClone({ ...row, tutorial: privateTutorial }));
              return { ...tutorial, pdf_reference: reference };
            }) };
          }
          if (projected.letter_type === 2 && projected.has_document) {
            const reference = createHash("sha256").update(JSON.stringify([2, row.item_date, row.original_item_date, row.link])).digest("hex");
            if (references.has(reference)) throw new ReadOperationError("INVALID_RESPONSE", operation);
            references.set(reference, structuredClone(row));
            return { ...projected, reference };
          }
          return { ...projected };
        } catch (error) {
          if (error instanceof GeneralMailingContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
          throw error;
        }
      }
      if (row.letter_type !== 1) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
      const selected: SourceRecord = { letter_type: row.letter_type };
      if (typeof row.reference_id === "string" && row.reference_id && typeof row.name_document === "string" && row.name_document) {
        const reference = createHash("sha256").update(JSON.stringify([row.reference_id, row.name_document])).digest("hex");
        if (references.has(reference)) throw new ReadOperationError("INVALID_RESPONSE", operation);
        references.set(reference, structuredClone(row)); selected.reference = reference;
      }
      for (const field of ["letter_desc", "item_date", "original_item_date"]) selected[field] = string(row[field], operation);
      return selected;
    });
    this.notificationReferences.clear();
    for (const [reference, row] of references) this.notificationReferences.set(reference, row);
    this.notificationRange = JSON.stringify(range);
    const result = this.result(rows, "DirectorshipAPI", operation);
    if (rows.some(row => row.letter_type !== 1)) result.source.schemaEvidence = "frontend-field-projection";
    return result;
  }

  async getNotificationPdf(reference: string, range: DateRange): Promise<ReadResult<Uint8Array>> {
    validateDateRange(range);
    const operation = "notification-pdf";
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (this.notificationRange !== JSON.stringify(range) || [2, 3].includes(this.notificationReferences.get(reference)?.letter_type as number)) await this.listNotifications(range);
    const row = this.notificationReferences.get(reference);
    if (!row) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (row.letter_type === 2) {
      const features = this.rows(await json(this.transport, this.path("MainAppAPI", "v1", "features"), operation), operation).filter(feature => feature.feature_id === "isOpenPdfByLinkHandlerV2");
      if (features.length !== 1 || typeof features[0]!.feature_enabled !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
      const component = (value: unknown): string => {
        const raw = string(value, operation);
        if (!raw || raw.length > 16384 || /[&#?=\u0000-\u0020\u007f]/.test(raw) || /%(?![0-9a-fA-F]{2})/.test(raw)) throw new ReadOperationError("INVALID_RESPONSE", operation);
        return raw;
      };
      const query = `file_path=${component(row.link)}&timestamp=${component(row.timestamp)}`;
      if (!features[0]!.feature_enabled) return this.downloadSourcePdf(`${this.path("MainAppAPI", "v1", "pdf")}?${query}&hash=${component(row.hash)}`, "MainAppAPI", operation, 2 * 1024 * 1024);
      return this.downloadPendingMailingPdf(`${this.path("MainAppAPI", "v2", "pdf")}?${query}`, operation);
    }
    if (row.letter_type === 3) {
      const tutorial = object(row.tutorial, operation);
      const component = (value: unknown): string => {
        const raw = string(value, operation);
        if (!raw || raw.length > 16384 || /[&#?=\u0000-\u0020\u007f]/.test(raw) || /%(?![0-9a-fA-F]{2})/.test(raw)) throw new ReadOperationError("INVALID_RESPONSE", operation);
        return raw;
      };
      // The public renderer interpolates these already supplied query components directly.
      const query = `file_path=${component(tutorial.url)}&timestamp=${component(tutorial.timestamp)}&hash=${component(tutorial.hash)}`;
      return this.downloadSourcePdf(`${this.path("MainAppAPI", "v1", "pdf/http")}?${query}`, "MainAppAPI", operation, 2 * 1024 * 1024);
    }
    const suffix = `letters_for_member/${encodeURIComponent(string(row.reference_id, operation))}/${encodeURIComponent(string(row.name_document, operation))}/pdf`;
    const query = new URLSearchParams({ timestamp: string(row.timestamp, operation), hash: decodeSourceQueryComponent(row.hash, operation) });
    return this.downloadSourcePdf(`${this.path("DirectorshipAPI", "v1", suffix)}?${query}`, "DirectorshipAPI", operation);
  }

  /** The source V2 blob reader waits five seconds for successful pending responses. */
  private async downloadPendingMailingPdf(input: string, operation: string): Promise<ReadResult<Uint8Array>> {
    const requested = new URL(input, PORTAL_ORIGIN);
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await this.transport.request(input);
      const finalUrl = new URL(response.url || input, PORTAL_ORIGIN);
      if (finalUrl.origin === "https://mac.maccabi4u.co.il" || ["/my.logout.php3", "/my.policy", "/mac/login"].includes(finalUrl.pathname.toLowerCase())) { await discard(response); throw new ReauthenticationRequired(response.status); }
      if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
      if (finalUrl.origin !== requested.origin || finalUrl.pathname !== requested.pathname || finalUrl.search !== requested.search) { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
      if (response.status === 200) {
        if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/pdf") { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
        const length = response.headers.get("content-length");
        if (length !== null && /^\d+$/.test(length) && Number(length) > 2 * 1024 * 1024) { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
        const bytes = await readCappedBody(response, PDF_BYTE_LIMIT, new ReadOperationError("INVALID_RESPONSE", operation));
        if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new ReadOperationError("INVALID_RESPONSE", operation);
        return this.result(bytes, "MainAppAPI", operation);
      }
      await discard(response);
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new ReadOperationError("UPSTREAM_RESULT_ERROR", operation);
  }

  /** Quarterly report catalog, first upstream page; not itemized charges or PDF contents. */
  async listQuarterlyBillingReports(period?: string): Promise<ReadResult<QuarterlyBillingCatalog>> {
    if (period !== undefined && !/^\d{1,4}$/.test(period)) throw new TypeError("period must be a value returned in availablePeriods");
    const operation = "quarterly-billing-reports";
    const html = await this.readLegacyPage("directorship/debitsandcredits/", operation);
    try {
      const { availablePeriods, defaultPeriod } = parseBillingPeriods(html);
      const selectedPeriod = period === undefined ? defaultPeriod : availablePeriods.find(option => option.value === period);
      if (!selectedPeriod) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
      const path = "/online/Ajax/DebitsAndCredits/WcDebitsAndCreditsManager.asmx/GetQuarterlyReport";
      // The captured public script sends this ASP.NET single-quoted envelope. Value is page-bound digits.
      const response = await this.transport.request(path, { method: "POST", apiAuthorization: false, headers: { "content-type": "application/json; charset=utf-8" }, body: `{'value':'${selectedPeriod.value}'}` });
      const finalUrl = new URL(response.url || path, PORTAL_ORIGIN);
      if (finalUrl.origin === "https://mac.maccabi4u.co.il" || ["/my.logout.php3", "/my.policy", "/mac/login"].includes(finalUrl.pathname.toLowerCase())) { await discard(response); throw new ReauthenticationRequired(response.status); }
      if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
      if (finalUrl.origin !== PORTAL_ORIGIN || finalUrl.pathname !== path || finalUrl.search || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
      const raw = await legacyBody(response, operation);
      let decoded: unknown;
      try { decoded = JSON.parse(raw); } catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
      const envelope = object(decoded, operation);
      if (Object.keys(envelope).length !== 1 || typeof envelope.d !== "string") throw new ReadOperationError("INVALID_RESPONSE", operation);
      const { reports, pagination } = parseQuarterlyBillingRows(envelope.d);
      const documents = parseQuarterlyBillingDocuments(envelope.d, reports);
      this.quarterlyBillingDocuments.clear();
      for (const document of documents) this.quarterlyBillingDocuments.set(document.reference, { token: document.token, reportType: document.reportType });
      return this.result({ availablePeriods, selectedPeriod, reports: reports.map((report, i) => ({ ...report, reference: documents[i]!.reference })), pagination }, "LegacyBillingCatalog", operation);
    } catch (error) { if (error instanceof LegacyContentError) throw new ReadOperationError("INVALID_RESPONSE", operation); throw error; }
  }

  /** Original quarterly PDF from one unique row in a freshly loaded owner/period catalog. */
  async getQuarterlyBillingReportPdf(reference: string, period: string): Promise<ReadResult<Uint8Array>> {
    const operation = "quarterly-billing-report-pdf";
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (typeof period !== "string" || !/^\d{1,4}$/.test(period)) throw new TypeError("period must be a value returned in availablePeriods");
    await this.listQuarterlyBillingReports(period);
    const document = this.quarterlyBillingDocuments.get(reference);
    if (!document) throw new ReadOperationError("OWNER_MISMATCH", operation);
    return this.downloadBillingArchive(document, operation, "token");
  }

  /** Annual nursing-insurance catalog visible in the current owner's billing page. */
  async listNursingInsuranceReports(): Promise<ReadResult<NursingInsuranceCatalog>> {
    const operation = "nursing-insurance-reports";
    await this.readLegacyPage("directorship/debitsandcredits/", operation);
    const path = "/online/Ajax/DebitsAndCredits/WcDebitsAndCreditsManager.asmx/GetLTCReport";
    const response = await this.transport.request(path, { method: "POST", apiAuthorization: false, headers: { "content-type": "application/json; charset=utf-8" }, body: "" });
    const finalUrl = new URL(response.url || path, PORTAL_ORIGIN);
    if (finalUrl.origin === "https://mac.maccabi4u.co.il" || ["/my.logout.php3", "/my.policy", "/mac/login"].includes(finalUrl.pathname.toLowerCase())) { await discard(response); throw new ReauthenticationRequired(response.status); }
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    if (finalUrl.origin !== PORTAL_ORIGIN || finalUrl.pathname !== path || finalUrl.search || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
    try {
      const envelope = object(JSON.parse(await legacyBody(response, operation)), operation);
      if (Object.keys(envelope).length !== 1 || typeof envelope.d !== "string") throw new ReadOperationError("INVALID_RESPONSE", operation);
      const catalog = parseNursingInsuranceRows(envelope.d);
      const documents = parseNursingInsuranceDocuments(envelope.d, catalog.reports);
      this.nursingInsuranceDocuments.clear();
      for (const document of documents) this.nursingInsuranceDocuments.set(document.reference, { token: document.token, reportType: document.reportType });
      return this.result({ ...catalog, reports: catalog.reports.map((report, index) => ({ ...report, reference: documents[index]!.reference })) }, "LegacyBillingCatalog", operation);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof LegacyContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
  }

  async getNursingInsuranceReportPdf(reference: string): Promise<ReadResult<Uint8Array>> {
    const operation = "nursing-insurance-report-pdf";
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    await this.listNursingInsuranceReports();
    const document = this.nursingInsuranceDocuments.get(reference);
    if (!document) throw new ReadOperationError("OWNER_MISMATCH", operation);
    return this.downloadBillingArchive(document, operation, "Token");
  }

  private async downloadBillingArchive(document: {token: string; reportType: string}, operation: string, tokenKey: "token" | "Token"): Promise<ReadResult<Uint8Array>> {
    const path = "/online/Ajax/DebitsAndCredits/WcDebitsAndCreditsManager.asmx/GetDocFromArchive";
    const response = await this.transport.request(path, { method: "POST", apiAuthorization: false, headers: { "content-type": "application/json; charset=utf-8" }, body: `{'token':'${document.token}', 'reportType':'${document.reportType}'}` });
    const finalUrl = new URL(response.url || path, PORTAL_ORIGIN);
    if (finalUrl.origin === "https://mac.maccabi4u.co.il" || ["/my.logout.php3", "/my.policy", "/mac/login"].includes(finalUrl.pathname.toLowerCase())) { await discard(response); throw new ReauthenticationRequired(response.status); }
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    if (finalUrl.origin !== PORTAL_ORIGIN || finalUrl.pathname !== path || finalUrl.search || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
    let decoded: unknown;
    try { decoded = JSON.parse(await legacyBody(response, operation)); } catch (error) { if (error instanceof SyntaxError) throw new ReadOperationError("INVALID_RESPONSE", operation); throw error; }
    const envelope = object(decoded, operation);
    if (Object.keys(envelope).length !== 1 || typeof envelope.d !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
    if (!envelope.d) throw new ReadOperationError("UPSTREAM_RESULT_ERROR", operation);
    const query = `${tokenKey}=${document.token}&ReportType=${document.reportType}&FileName=DebitsAndCreditsReportInformation`;
    return this.downloadSourcePdf(`/online/Pages/Popups/DebitsAndCredits/DebitsAndCreditsPdfReport.aspx?${query}`, "LegacyBillingCatalog", operation, 2 * 1024 * 1024);
  }

  async getMedicalRecommendations(): Promise<ReadResult<LegacyRecommendations>> {
    const operation = "medical-recommendations";
    const html = await this.readLegacyPage("medicalfile/personalrecommendations/", operation);
    try { return this.result(parseLegacyRecommendations(html), "LegacyMedicalFile", operation); }
    catch (error) { if (error instanceof LegacyContentError) throw new ReadOperationError("INVALID_RESPONSE", operation); throw error; }
  }

  /** Persisted notification settings; never saves edits or applies preferences to family members. */
  async getNotificationPreferences(): Promise<ReadResult<NotificationPreferences>> {
    const operation = "notification-preferences";
    await this.readLegacyPage("directorship/personalreminders/", operation);
    const path = "/online/webapi/PersonalRemindersESB/GetReminders/";
    const response = await this.transport.request(path, { apiAuthorization: false });
    const finalUrl = new URL(response.url || path, PORTAL_ORIGIN);
    if (finalUrl.origin === "https://mac.maccabi4u.co.il" || ["/my.logout.php3", "/my.policy", "/mac/login"].includes(finalUrl.pathname.toLowerCase())) { await discard(response); throw new ReauthenticationRequired(response.status); }
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    if (finalUrl.origin !== PORTAL_ORIGIN || finalUrl.pathname !== path || finalUrl.search || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
    let value: unknown;
    try { value = JSON.parse(await legacyBody(response, operation)); }
    catch (error) { if (error instanceof SyntaxError) throw new ReadOperationError("INVALID_RESPONSE", operation); throw error; }
    const data = object(value, operation);
    assertRecordOwner(data, this.owner, operation);
    const code = object(data.ResultMessage, operation).Code;
    if (typeof code !== "number" || !Number.isSafeInteger(code)) throw new ReadOperationError("INVALID_RESPONSE", operation);
    if (code !== 0) throw new ReadOperationError("UPSTREAM_RESULT_ERROR", operation);
    try {
      const result = this.result(projectNotificationPreferences(data), "LegacyPersonalReminders", operation);
      return { ...result, source: { ...result.source, schemaEvidence: "frontend-field-projection" } };
    } catch (error) {
      if (error instanceof NotificationPreferencesContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
  }

  async getSelectedMedicalSummary(): Promise<ReadResult<LegacySelectedSummary>> {
    const operation = "selected-medical-summary";
    const html = await this.readLegacyPage("medicalfile/summary/", operation);
    try { return this.result(parseLegacySelectedSummary(html), "LegacyMedicalFile", operation); }
    catch (error) { if (error instanceof LegacyContentError) throw new ReadOperationError("INVALID_RESPONSE", operation); throw error; }
  }

  /** Captured hospital/ER history default lookback, computed from the supplied local calendar date. */
  async listHospitalHistory(asOf: string, range?: DateRange): Promise<ReadResult<SourceRecord[]>> {
    validateDateRange({ from: asOf, to: asOf });
    if (range) validateDateRange(range);
    const operation = "hospital-history";
    const html = await this.readLegacyPage("medicalfile/mailingsfromhospitals/", operation);
    let yearsBack: number;
    try { yearsBack = parseLegacyHospitalSettings(html).yearsBack; }
    catch (error) { if (error instanceof LegacyContentError) throw new ReadOperationError("INVALID_RESPONSE", operation); throw error; }
    const [year, month, day] = asOf.split("-") as [string, string, string];
    // Mirror the observed controller's numeric DDMMYYYY arithmetic without timezone conversion.
    const toDate = Number(`${day}${month}${year}`);
    let selection: {isDateSelected: boolean; fromDate: number | string; toDate: number | string} = { isDateSelected: false, fromDate: toDate - yearsBack, toDate };
    if (range) {
      const minimum = new Date(Date.parse(`${asOf}T00:00:00Z`) - yearsBack * 365 * 86400000).toISOString().slice(0, 10);
      if (range.from < minimum || range.to > asOf) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
      const sourceDate = (value: string) => value.split("-").reverse().join("");
      selection = { isDateSelected: true, fromDate: sourceDate(range.from), toDate: sourceDate(range.to) };
    }
    const response = await this.transport.request("/online/webapi/MailingsFromHospitals/GetMailingsFromHospitals/", { ...this.post(selection), apiAuthorization: false });
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    const finalUrl = new URL(response.url || "/online/webapi/MailingsFromHospitals/GetMailingsFromHospitals/", PORTAL_ORIGIN);
    if (finalUrl.origin === "https://mac.maccabi4u.co.il" || ["/my.logout.php3", "/my.policy", "/mac/login"].includes(finalUrl.pathname.toLowerCase())) { await discard(response); throw new ReauthenticationRequired(response.status); }
    if (finalUrl.origin !== PORTAL_ORIGIN || finalUrl.pathname.toLowerCase() !== "/online/webapi/mailingsfromhospitals/getmailingsfromhospitals/" || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
    const data = object(await readResponseBody(() => response.json(), new ReadOperationError("INVALID_RESPONSE", operation)), operation);
    const message = object(data.ResultMessage, operation);
    if (typeof message.Code !== "number") throw new ReadOperationError("INVALID_RESPONSE", operation);
    if (message.Code !== 0) throw new ReadOperationError("UPSTREAM_RESULT_ERROR", operation);
    const references = new Map<string, SourceRecord>();
    const rows = this.rows(data.ReportHospitalizations, operation).map(row => {
      const selected: SourceRecord = {};
      for (const field of ["NameHospital", "DateHospitalization", "Date", "DurationHospitalization", "QuantityTreatments", "TypeCommitment", "Department"]) selected[field] = string(row[field], operation);
      if (typeof row.HasLink !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
      selected.HasLink = row.HasLink;
      if (row.HasLink) {
        const path = string(row.LinkPDF, operation), type = string(row.TypeCommitmentEgenKey, operation);
        if (!path || !type) throw new ReadOperationError("INVALID_RESPONSE", operation);
        const reference = createHash("sha256").update(JSON.stringify([path, type])).digest("hex");
        if (references.has(reference)) throw new ReadOperationError("INVALID_RESPONSE", operation);
        references.set(reference, structuredClone(row));
        selected.reference = reference;
      }
      for (const field of ["DescriptionTreatment", "DescriptionDistinction"]) selected[field] = this.rows(row[field], operation).map(item => ({ Description: string(item.Description, operation) }));
      return selected;
    });
    this.hospitalReferences.clear();
    for (const [reference, row] of references) this.hospitalReferences.set(reference, row);
    this.hospitalReferenceSelection = JSON.stringify([asOf, range ?? null]);
    return this.result(rows, "LegacyHospitalMailings", operation);
  }

  /** Original private report resolved only from the same dated owner hospital list. */
  async getHospitalReportPdf(reference: string, asOf: string, range?: DateRange): Promise<ReadResult<Uint8Array>> {
    validateDateRange({ from: asOf, to: asOf });
    if (range) validateDateRange(range);
    const operation = "hospital-report-pdf";
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (this.hospitalReferenceSelection !== JSON.stringify([asOf, range ?? null])) await this.listHospitalHistory(asOf, range);
    const row = this.hospitalReferences.get(reference);
    if (!row) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const path = "/online/Pages/Popups/MailingsFromHospitals/MailingsFromHospitals.aspx";
    const query = new URLSearchParams({ path: string(row.LinkPDF, operation), typeCommitment: string(row.TypeCommitmentEgenKey, operation) });
    return this.downloadSourcePdf(`${path}?${query}`, "LegacyHospitalMailings", operation, 2 * 1024 * 1024);
  }

  private async readLegacyPage(alias: "directorship/debitsandcredits/" | "directorship/personalreminders/" | "medicalfile/personalrecommendations/" | "medicalfile/summary/" | "medicalfile/mailingsfromhospitals/", operation: string): Promise<string> {
    const seed = this.appointmentOwnerData.legacySessionId;
    if (!this.transport.getOrCreatePortalNavigationSession || typeof seed !== "string" || !seed) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const session = await this.transport.getOrCreatePortalNavigationSession(this.owner, seed);
    const path = `/online/${alias}`;
    const query = new URLSearchParams({ relative: "-1", sr_id: session });
    const response = await this.transport.request(`${path}?${query}`, { apiAuthorization: false });
    const finalUrl = new URL(response.url || path, PORTAL_ORIGIN);
    if (finalUrl.origin === "https://mac.maccabi4u.co.il" || ["/my.logout.php3", "/my.policy", "/mac/login"].includes(finalUrl.pathname.toLowerCase())) { await discard(response); throw new ReauthenticationRequired(response.status); }
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    if (finalUrl.origin !== PORTAL_ORIGIN || finalUrl.pathname.toLowerCase() !== path.toLowerCase() || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/html") { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
    const html = await legacyBody(response, operation);
    // The exact login HTML bootstrap assignment is also used by the source-backed login parser.
    if (/(?:window\.)?originJWT\s*=\s*["'][A-Za-z0-9_.-]+["']/.test(html)) throw new ReauthenticationRequired(response.status);
    try { assertLegacyPageOwner(html, this.owner.memberId); }
    catch (error) {
      if (error instanceof LegacyOwnerMismatchError) throw new ReadOperationError("OWNER_MISMATCH", operation);
      // A marker this parser could not find or read is a gap in this client, not a stale reference.
      // None of the five reads that land here takes a reference or an id, so the OWNER_MISMATCH
      // guidance - re-run the originating list, use a fresh reference - names nothing the caller has.
      if (error instanceof LegacyContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
    return html;
  }

  /** Grouped vaccination history, not individual dose records. Observed S5 record717. */
  async listVaccinationGroups(): Promise<ReadResult<VaccinationGroup[]>> {
    const operation = "vaccination-groups";
    const data = object(await json(this.transport, this.path("MedicalFileAPI", "v1", "vaccinations_grouped"), operation), operation);
    const rows = this.rows(data.timeline, operation).map(row => {
      for (const field of ["vaccine_group_code", "vaccinations_amount"]) if (typeof row[field] !== "number" || !Number.isSafeInteger(row[field]) || (row[field] as number) < 0) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return {
        vaccine_group_code: row.vaccine_group_code as number, vaccinations_amount: row.vaccinations_amount as number,
        vaccine_group_name: string(row.vaccine_group_name, operation), first_date: string(row.first_date, operation),
        last_date: string(row.last_date, operation), timestamp: string(row.timestamp, operation),
      };
    });
    this.vaccinationGroupReferences.clear();
    for (const row of rows) {
      if (this.vaccinationGroupReferences.has(row.vaccine_group_code)) throw new ReadOperationError("INVALID_RESPONSE", operation);
      this.vaccinationGroupReferences.add(row.vaccine_group_code);
    }
    return this.result(rows, "MedicalFileAPI", operation);
  }

  /** Fixed dose projection from the official group-expansion renderer; group references are owner-list bound. */
  async getVaccinationDoses(groupCode: number): Promise<ReadResult<SourceRecord[]>> {
    const operation = "vaccination-doses";
    if (!Number.isSafeInteger(groupCode) || groupCode < 0) throw new TypeError("groupCode must be a nonnegative safe integer");
    if (!this.vaccinationGroupReferences.size) await this.listVaccinationGroups();
    if (!this.vaccinationGroupReferences.has(groupCode)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const query = new URLSearchParams({ vaccine_group_code: String(groupCode), birth_date: this.profile.birth_date });
    const data = await json(this.transport, `${this.path("MedicalFileAPI", "v1", "vaccinations")}?${query}`, operation);
    const rows = this.rows(data, operation).map(row => {
      const selected: SourceRecord = { vaccination_date: string(row.vaccination_date, operation) };
      for (const field of ["vaccination_place", "age_on_vaccination", "remark", "source"]) {
        if (!Object.hasOwn(row, field)) continue;
        if (row[field] !== null && typeof row[field] !== "string") throw new ReadOperationError("INVALID_RESPONSE", operation);
        selected[field] = row[field];
      }
      return selected;
    });
    return { ...this.result(rows, "MedicalFileAPI", operation), source: { service: "MedicalFileAPI", operation, completeness: "upstream-response", schemaEvidence: "frontend-field-projection" } };
  }

  /** Empty response captured; populated display fields come from the official sensitivity timeline source. */
  async listSensitivities(): Promise<ReadResult<SourceRecord[]>> {
    const operation = "sensitivities";
    const data = object(await json(this.transport, this.path("MedicalFileAPI", "v1", "sensitivity"), operation), operation);
    if (!Array.isArray(data.intolerance)) throw new ReadOperationError("INVALID_RESPONSE", operation);
    const rows = this.rows(data.intolerance, operation).map(row => {
      if (!Object.hasOwn(row, "registration_date") || !Object.hasOwn(row, "sensitivity")) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
      const selected: SourceRecord = {};
      for (const field of ["registration_date", "sensitivity", "practitioner_name", "speciality", "sensitivity_presentation", "classification"]) {
        if (!Object.hasOwn(row, field)) continue;
        const value = row[field];
        if (value !== null && typeof value !== "string" && typeof value !== "number") throw new ReadOperationError("INVALID_RESPONSE", operation);
        selected[field] = value;
      }
      return selected;
    });
    const result = this.result(rows, "MedicalFileAPI", operation);
    result.source.schemaEvidence = "frontend-field-projection";
    return result;
  }

  async getSensitivityPdf(): Promise<ReadResult<Uint8Array>> {
    const operation = "sensitivity-pdf";
    const data = object(await json(this.transport, this.path("MedicalFileAPI", "v1", "sensitivity/pdf"), operation), operation);
    return this.result(decodeBase64Pdf(data.base64, operation), "MedicalFileAPI", operation);
  }

  /** Additional-information document descriptions; populated display fields are frontend-derived. */
  async listAdditionalInformation(range: DateRange): Promise<ReadResult<SourceRecord[]>> {
    validateDateRange(range);
    const operation = "additional-information";
    const query = new URLSearchParams({ from_date: range.from, to_date: range.to });
    const data = object(await json(this.transport, `${this.path("MedicalFileAPI", "v1", "tutorials")}?${query}`, operation), operation);
    const references = new Map<string, SourceRecord>();
    const rows = this.rows(data.tutorials, operation).map(row => {
      if (typeof row.url !== "string" || !row.url || typeof row.session_datetime !== "string" || !row.session_datetime || ![1, 2, 3].includes(row.type_id as number)) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
      const selected: SourceRecord = { session_datetime: row.session_datetime, type_id: row.type_id };
      if (row.type_id === 1) {
        const reference = createHash("sha256").update(row.url).digest("hex");
        if (references.has(reference)) throw new ReadOperationError("INVALID_RESPONSE", operation);
        references.set(reference, structuredClone(row)); selected.reference = reference;
      }
      for (const field of ["display_text", "practitioner_name", "specialization"]) {
        if (!Object.hasOwn(row, field)) continue;
        if (row[field] !== null && typeof row[field] !== "string" && typeof row[field] !== "number") throw new ReadOperationError("INVALID_RESPONSE", operation);
        selected[field] = row[field];
      }
      return selected;
    });
    this.informationReferences.clear();
    for (const [reference, row] of references) this.informationReferences.set(reference, row);
    this.informationRange = JSON.stringify(range);
    const result = this.result(rows, "MedicalFileAPI", operation);
    result.source.schemaEvidence = "frontend-field-projection";
    return result;
  }

  async getAdditionalInformationPdf(reference: string, range: DateRange): Promise<ReadResult<Uint8Array>> {
    validateDateRange(range);
    const operation = "additional-information-pdf";
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (this.informationRange !== JSON.stringify(range)) await this.listAdditionalInformation(range);
    const row = this.informationReferences.get(reference);
    if (!row) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const query = new URLSearchParams({ url: decodeSourceQueryComponent(row.url, operation), timestamp: string(row.timestamp, operation), hash: decodeSourceQueryComponent(row.hash, operation) });
    return this.downloadSourcePdf(`${this.path("MedicalFileAPI", "v2", "pdf")}?${query}`, "MedicalFileAPI", operation);
  }

  async listCertificates(range: DateRange): Promise<ReadResult<MedicalCertificate[]>> {
    validateDateRange(range);
    const operation = "medical-certificates";
    const query = new URLSearchParams({ from_date: range.from, to_date: range.to });
    const data = object(await json(this.transport, `${this.path("MedicalFileAPI", "v1", "approvals")}?${query}`, operation), operation);
    const records = this.rows(data.approval, operation);
    const references = new Map<string, SourceRecord>();
    const rows = records.map(row => {
      const reference = createHash("sha256").update(string(row.pdf_link, operation)).digest("hex");
      for (const field of ["timestamp", "hash"]) string(row[field], operation);
      if (references.has(reference)) throw new ReadOperationError("INVALID_RESPONSE", operation);
      references.set(reference, structuredClone(row));
      const selected: SourceRecord = { reference };
      for (const field of ["title_name", "practitioner_full_name", "specialization_description", "approval_date", "approval_date_from", "approval_date_to", "approval_type_code"]) selected[field] = string(row[field], operation);
      return selected as MedicalCertificate;
    });
    this.certificateReferences.clear();
    for (const [reference, record] of references) this.certificateReferences.set(reference, record);
    return this.result(rows, "MedicalFileAPI", operation);
  }

  async getCertificatePdf(reference: string, range: DateRange): Promise<ReadResult<Uint8Array>> {
    validateDateRange(range);
    const operation = "medical-certificate-pdf";
    if (!this.certificateReferences.has(reference)) await this.listCertificates(range);
    const record = this.certificateReferences.get(reference);
    if (!record) throw new ReadOperationError("OWNER_MISMATCH", operation);
    return this.downloadMedicalFilePdf(record, operation);
  }

  /** Original owner vaccination certificate; may contain printed personal identifiers. */
  async getVaccinationCertificatePdf(): Promise<ReadResult<Uint8Array>> {
    const operation = "vaccination-certificate-pdf";
    const data = object(await json(this.transport, this.path("MedicalFileAPI", "v1", "vaccination/certificates/report"), operation), operation);
    const bytes = decodePdfEnvelope(data, operation);
    return this.result(bytes, "MedicalFileAPI", operation);
  }

  /** Original purchased-prescription report returned by the medication screen's report action. */
  async getMedicationReportPdf(): Promise<ReadResult<Uint8Array>> {
    const operation = "medication-report-pdf";
    const data = object(await json(this.transport, this.path("MedicalFileAPI", "v1", "prescriptions/purchased/report"), operation), operation);
    return this.result(decodePdfEnvelope(data, operation), "MedicalFileAPI", operation);
  }

  /** Retrieves the original English medical summary using owner-derived access metadata. Never updates identity. */
  async getEnglishMedicalSummaryPdf(): Promise<ReadResult<Uint8Array>> {
    const operation = "english-medical-summary-pdf";
    const metadata = object(await json(this.transport, this.path("DirectorshipAPI", "v1", "timestampAndHash"), operation), operation);
    const query = new URLSearchParams({ timestamp: string(metadata.timestamp, operation), hash: decodeSourceQueryComponent(metadata.hash, operation) });
    const response = await this.transport.request(`${this.path("DirectorshipAPI", "v1", "report/english/")}?${query}`, { apiAuthorization: false });
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    const bytes = await readCappedBody(response, PDF_BYTE_LIMIT, new ReadOperationError("INVALID_RESPONSE", operation));
    if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/pdf" || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new ReadOperationError("INVALID_RESPONSE", operation);
    return this.result(bytes, "DirectorshipAPI", operation);
  }

  /** Current payment-method metadata, excluding the full bank account number and authorization material. */
  async getPaymentMethods(): Promise<ReadResult<SourceRecord>> {
    const operation = "payment-methods";
    const path = `/sonline/DirectorshipAPI/webapi/mac/v1/payers/${encodeURIComponent(this.owner.memberIdCode)}/${this.owner.memberId}/debit_authorization`;
    const data = object(await json(this.transport, path, operation), operation);
    const selected: SourceRecord = {};
    for (const field of ["is_active_auth_exists", "is_credit_auth_only", "is_shaban_auth_only"]) {
      if (typeof data[field] !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
      selected[field] = data[field];
    }
    for (const field of ["payment_method", "bank_code", "branch_code", "payer_type"]) {
      if (typeof data[field] !== "number" || !Number.isFinite(data[field])) throw new ReadOperationError("INVALID_RESPONSE", operation);
      selected[field] = data[field];
    }
    for (const field of ["bank_name", "branch_name", "credit_card_type", "last_four_digits_credit_card"]) selected[field] = string(data[field], operation);
    if (data.auth_start_date !== null && typeof data.auth_start_date !== "string") throw new ReadOperationError("INVALID_RESPONSE", operation);
    selected.auth_start_date = data.auth_start_date;
    return this.result(selected, "DirectorshipAPI", operation);
  }

  /** Observed billing-total branch only; amounts retain upstream semantics and have no inferred currency. */
  async getOutstandingDebt(): Promise<ReadResult<SourceRecord>> {
    const operation = "outstanding-debt";
    if (this.appointmentOwnerData.hasOtherPayer !== true) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const data = object(await json(this.transport, `${this.path("DirectorshipAPI", "v1", "finance/debts")}?person_type=1`, operation), operation);
    const selected: SourceRecord = {};
    for (const field of ["kupa_debt", "shaban_debt", "additional_charges_debt"]) {
      if (typeof data[field] !== "number" || !Number.isFinite(data[field])) throw new ReadOperationError("INVALID_RESPONSE", operation);
      selected[field] = data[field];
    }
    const result = this.result(selected, "DirectorshipAPI", operation);
    result.source.scope = "payer-account-aggregate";
    return result;
  }

  /** Administrative approvals/reimbursements/commitments timeline. Populated projection comes from official UI source. */
  async listAdministrativeRequests(): Promise<ReadResult<SourceRecord[]>> {
    const operation = "administrative-requests";
    const data = await json(this.transport, this.path("RequestsAndApprovalsAPI", "v1", "requests_and_cases"), operation, this.post({ members: [this.member()] }));
    const rows = this.rows(data, operation).map(row => {
      if (String(row.member_id) !== String(this.owner.memberId)) throw new ReadOperationError("OWNER_MISMATCH", operation);
      if (!((typeof row.interaction_id === "string" && row.interaction_id.length > 0) || (typeof row.interaction_id === "number" && Number.isFinite(row.interaction_id))) || typeof row.classification !== "string") throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
      const selected: SourceRecord = {};
      for (const field of ["interaction_id", "classification", "type_code", "type_name", "subject", "status", "status_code", "status_update_date", "create_date", "request_create_date", "drug_names_for_approval", "drug_largo_code", "obligation_provider_name", "obligation_treatment_date", "item_code"]) {
        if (!Object.hasOwn(row, field)) continue;
        const value = row[field];
        if (value !== null && typeof value !== "string" && typeof value !== "number") throw new ReadOperationError("INVALID_RESPONSE", operation);
        selected[field] = value;
      }
      for (const field of ["has_content", "is_read", "is_maccabi_file_attached"]) {
        if (!Object.hasOwn(row, field)) continue;
        if (row[field] !== null && typeof row[field] !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
        selected[field] = row[field];
      }
      return selected;
    });
    const result = this.result(rows, "RequestsAndApprovalsAPI", operation);
    result.source.schemaEvidence = "frontend-field-projection";
    return result;
  }

  /** Common administrative correspondence only; unsupported source sections are reported explicitly. */
  async getAdministrativeRequest(interactionId: string): Promise<ReadResult<AdministrativeDetail>> {
    const operation = "administrative-request";
    if (typeof interactionId !== "string" || !interactionId || interactionId.length > 512) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const listed = await this.listAdministrativeRequests();
    const matches = listed.data.filter(row => String(row.interaction_id) === interactionId);
    if (matches.length !== 1) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const classification = matches[0]!.classification;
    if (classification !== "Case" && classification !== "ServiceRequest") throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const route = classification === "Case" ? "cases" : "service_requests";
    const data = object(await json(this.transport, this.path("RequestsAndApprovalsAPI", "v1", `${route}/${encodeURIComponent(interactionId)}`), operation), operation);
    assertRecordOwner(data, this.owner, operation);
    if (data.interaction_id !== undefined && String(data.interaction_id) !== interactionId) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (data.documents !== undefined && data.documents !== null) this.rows(data.documents, operation);
    if (data.provider_document !== undefined && data.provider_document !== null) assertRecordOwner(object(data.provider_document, operation), this.owner, operation);
    if (data.messages !== undefined && data.messages !== null) for (const message of this.rows(data.messages, operation)) {
      if (message.documents !== undefined && message.documents !== null) this.rows(message.documents, operation);
    }
    if (data.extended_properties !== undefined && data.extended_properties !== null) {
      const extended = object(data.extended_properties, operation);
      assertRecordOwner(extended, this.owner, operation);
      for (const field of ["obligation_details", "medication_approval", "obligation", "refund", "preauthorization", "ombudsman"]) {
        if (extended[field] === undefined || extended[field] === null) continue;
        const section = object(extended[field], operation);
        assertRecordOwner(section, this.owner, operation);
        if (field === "obligation_details") {
          for (const name of ["doctor_referral", "department", "service_provider"]) if (section[name] !== undefined && section[name] !== null) assertRecordOwner(object(section[name], operation), this.owner, operation);
          if (section.treatment_array !== undefined && section.treatment_array !== null) this.rows(section.treatment_array, operation);
        }
      }
    }
    let featureContext: AdministrativeFeatureContext | undefined;
    if (classification === "Case" && Array.isArray(data.documents) && data.documents.length > 0) {
      const features = this.rows(await json(this.transport, this.path("MainAppAPI", "v1", "features"), operation), operation);
      featureContext = { IshurMakdim: false, IsCaseRejected: false, EnablePartlyApprovedObligation: false };
      for (const name of ["IshurMakdim", "IsCaseRejected", "EnablePartlyApprovedObligation"] as const) {
        const found = features.filter(feature => feature.feature_id === name);
        if (found.length > 1 || (found.length === 1 && typeof found[0]!.feature_enabled !== "boolean")) throw new ReadOperationError("INVALID_RESPONSE", operation);
        if (found.length) featureContext[name] = found[0]!.feature_enabled as boolean;
      }
    }
    try {
      const projected = projectAdministrativeDetail(data, classification, interactionId, featureContext);
      this.administrativeDocuments.set(interactionId, new Map(projected.documents.map(document => [document.reference, structuredClone(document)])));
      const result = this.result(projected.detail, "RequestsAndApprovalsAPI", operation);
      result.source.schemaEvidence = "frontend-field-projection";
      return result;
    } catch (error) {
      if (error instanceof AdministrativeDetailContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
  }

  async getAdministrativeRequestPdf(interactionId: string, reference: string): Promise<ReadResult<Uint8Array>> {
    const operation = "administrative-request-pdf";
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    await this.getAdministrativeRequest(interactionId);
    const document = this.administrativeDocuments.get(interactionId)?.get(reference);
    if (!document) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (document.kind === "base64") {
      if (document.base64.length > Math.ceil(2 * 1024 * 1024 / 3) * 4) throw new ReadOperationError("INVALID_RESPONSE", operation);
      const bytes = decodeBase64Pdf(document.base64, operation);
      if (bytes.byteLength > 2 * 1024 * 1024) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return this.result(bytes, "RequestsAndApprovalsAPI", operation);
    }
    const component = (value: unknown): string => {
      const raw = string(value, operation);
      if (!raw || raw.length > 16384 || /[&#?=\u0000-\u0020\u007f]/.test(raw) || /%(?![0-9a-fA-F]{2})/.test(raw)) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return raw;
    };
    const query = `doc_uri=${component(document.uri)}&timestamp=${component(document.timestamp)}&hash=${component(document.hash)}`;
    return this.downloadSourcePdf(`${this.path("RequestsAndApprovalsAPI", "v1", "service_requests_document")}?${query}`, "RequestsAndApprovalsAPI", operation, 2 * 1024 * 1024);
  }

  async listInquiries(): Promise<ReadResult<Inquiry[]>> {
    const operation = "inquiries";
    const data = object(await json(this.transport, this.path("CommunicationWithDoctorAPI", "v1", "inquiries"), operation), operation);
    const seen = new Set<string>();
    const listedDocuments = new Map<string, {reference:string;document:AppointmentDocument}>();
    const rows = this.rows(data.inquiries, operation).map(row => {
      for (const field of ["request_id", "type", "service_provider_name", "request_status", "status_update_date"]) string(row[field], operation);
      if (!row.request_id || !row.type || seen.has(row.request_id as string)) throw new ReadOperationError("INVALID_RESPONSE", operation);
      if (String(row.member_id) !== String(this.owner.memberId) || String(row.member_id_code) !== this.owner.memberIdCode) throw new ReadOperationError("OWNER_MISMATCH", operation);
      seen.add(row.request_id as string);
      // Owner identity and document signatures are checked/used internally, not clinical list fields.
      const selected: SourceRecord = {};
      for (const field of ["request_id", "type", "service_provider_name", "request_status", "request_status_code", "status_update_date", "creation_date", "is_read", "is_attached", "is_active", "read_approval_require", "read_approval_date", "view_by_user_date", "request_subjects", "document_id"]) if (Object.hasOwn(row, field)) selected[field] = structuredClone(row[field]);
      if (row.request_subjects !== null && row.request_subjects !== undefined) selected.request_subjects = this.rows(row.request_subjects, operation).map(subject => ({ id: subject.id, name: string(subject.name, operation) }));
      if (row.type === "automatic_sick_permit") {
        const documents = this.rows(row.medical_forms_documents, operation);
        const document = documents[0];
        if (document && typeof document.result_file === "string" && document.result_file) {
          const documentId = row.document_id;
          if (!((typeof documentId === "string" && documentId.length > 0 && documentId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(documentId)) || (typeof documentId === "number" && Number.isSafeInteger(documentId) && documentId > 0))) throw new ReadOperationError("INVALID_RESPONSE", operation);
          if (document.result_file.length > 16384) throw new ReadOperationError("INVALID_RESPONSE", operation);
          try { encodeURIComponent(document.result_file); } catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
          for (const value of [document.timestamp,document.hash]) if (typeof value !== "string" || !value || value.length > 8192 || /[&#?=\u0000-\u0020\u007f]/.test(value) || /%(?![0-9a-fA-F]{2})/.test(value)) throw new ReadOperationError("INVALID_RESPONSE", operation);
          const reference = createHash("sha256").update(JSON.stringify([row.request_id,"automatic",documentId])).digest("hex");
          selected.pdf_reference = reference;
          listedDocuments.set(row.request_id as string,{reference,document:{path:document.result_file,timestamp:document.timestamp,hash:document.hash,informationSheet:false}});
        }
      }
      return selected as Inquiry;
    });
    this.inquiryReferences.clear();
    this.inquiryListedDocuments.clear();
    for (const [key,value] of listedDocuments) this.inquiryListedDocuments.set(key,value);
    for (const row of rows) this.inquiryReferences.set(row.request_id, structuredClone(row));
    return this.result(rows, "CommunicationWithDoctorAPI", operation);
  }

  /** Reads a listed expandable inquiry; never sends viewed/read-approval/status writes. */
  async getInquiry(requestId: string): Promise<ReadResult<SourceRecord>> {
    const operation = "inquiry";
    if (!this.inquiryReferences.has(requestId)) await this.listInquiries();
    const reference = this.inquiryReferences.get(requestId);
    if (!reference) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (reference.type === "automatic_sick_permit") throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const data = object(await json(this.transport, this.path("CommunicationWithDoctorAPI", "v1", `inquiries/${encodeURIComponent(requestId)}/details`), operation), operation);
    if (String(data.request_id) !== requestId || String(data.user_id) !== String(this.owner.memberId) || String(data.user_code) !== this.owner.memberIdCode) throw new ReadOperationError("OWNER_MISMATCH", operation);
    for (const field of ["patient_remark", "doctor_remark", "creation_date", "update_date", "doctor_name", "request_status_desc"]) string(data[field], operation);
    const selected: SourceRecord = {};
    for (const field of ["request_id", "request_status", "patient_age", "patient_remark", "is_print_in_doctors_office", "creation_date", "update_date", "is_expired", "doctor_name", "source", "is_viewed_by_user", "is_team", "is_from_recommendation", "service_code", "specialization_code", "doctor_remark", "form_type", "request_status_desc", "is_structured_request", "is_prescription_request", "is_referral_request", "is_approval_request", "is_general_request", "referral_request", "general_question_subject", "additional_text_for_drugs", "requested_validity", "doc_profession", "patient_gender", "doctor_gender", "is_attached", "personal_doctor_remark", "read_approval_date", "read_approval_require"]) if (Object.hasOwn(data, field)) selected[field] = structuredClone(data[field]);
    try { Object.assign(selected, projectInquiryClinicalRequests(data)); }
    catch (error) { if (error instanceof InquiryClinicalRequestContentError) throw new ReadOperationError("INVALID_RESPONSE", operation); throw error; }
    const documents = new Map<string, AppointmentDocument>();
    const showsApprovalDocuments = (reference.request_status_code === "1" || reference.request_status_code === "8") && (data.open_medical_record_number === undefined || data.open_medical_record_number === null);
    selected.medical_forms_details = this.rows(data.medical_forms_details, operation).map(row => {
      const form: SourceRecord = {};
      for (const field of ["document_id", "request_id", "doc_form_id", "valid_until", "valid_from", "presc_id", "document_status_id", "creation_date", "update_date", "is_delivered", "delivery_date", "document_type", "document_description", "file_name_title", "form_type"]) if (Object.hasOwn(row, field)) form[field] = structuredClone(row[field]);
      if (showsApprovalDocuments && [1,2,3,4,5].includes(row.form_type as number) && typeof row.link_pdf === "string" && row.link_pdf.length > 0) {
        const reference = createHash("sha256").update(JSON.stringify([requestId, row.form_type, row.link_pdf])).digest("hex");
        if (documents.has(reference)) throw new ReadOperationError("INVALID_RESPONSE", operation);
        documents.set(reference, {path:row.link_pdf,timestamp:row.timestamp,hash:row.hash,informationSheet:false});
        form.pdf_reference = reference;
      }
      return form;
    });
    if (data.open_medical_record_number !== undefined && data.open_medical_record_number !== null && data.open_medical_record_number !== "") {
      const reference = string(data.open_medical_record_number, operation);
      const visit = object(await json(this.transport, `${this.path("AppointmentOrderAPI", "v1", `visits/${encodeURIComponent(reference)}/`)}?isOpenMedicalRecordNumber=true`, operation), operation);
      if (String(visit.member_id) !== String(this.owner.memberId) || String(visit.member_id_code) !== this.owner.memberIdCode) throw new ReadOperationError("OWNER_MISMATCH", operation);
      const {projected, documents: visitDocuments} = this.projectAppointmentDocuments(visit, `inquiry:${requestId}`, operation);
      delete projected.member_id;
      delete projected.member_id_code;
      for (const [key,value] of visitDocuments) documents.set(key,value);
      if (typeof visit.visit_summary_pdf_link === "string" && visit.visit_summary_pdf_link) {
        const key = createHash("sha256").update(JSON.stringify([requestId,"summary",visit.visit_summary_pdf_link])).digest("hex");
        projected.summary_pdf_reference = key;
        documents.set(key,{path:visit.visit_summary_pdf_link,timestamp:visit.timestamp,hash:visit.hash,informationSheet:false});
      }
      selected.visit_summary = { ...this.result(projected, "AppointmentOrderAPI", "inquiry-associated-visit") };
    }
    this.inquiryDocumentRecords.set(requestId, documents);
    return this.result(selected, "CommunicationWithDoctorAPI", operation);
  }

  /** Original source-rendered document from a fresh owner inquiry or its associated visit. */
  async getInquiryDocumentPdf(requestId: string, reference: string): Promise<ReadResult<Uint8Array>> {
    const operation = "inquiry-document-pdf";
    if (typeof requestId !== "string" || !requestId || !/^[a-f0-9]{64}$/.test(reference)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    await this.listInquiries();
    const listed = this.inquiryReferences.get(requestId);
    if (!listed) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (listed.type === "automatic_sick_permit") {
      const selected = this.inquiryListedDocuments.get(requestId);
      if (!selected || selected.reference !== reference) throw new ReadOperationError("OWNER_MISMATCH", operation);
      const document = selected.document;
      return this.downloadAppointmentPdf(document.path,document.timestamp,document.hash,operation);
    }
    await this.getInquiry(requestId);
    const document = this.inquiryDocumentRecords.get(requestId)?.get(reference);
    if (!document) throw new ReadOperationError("OWNER_MISMATCH", operation);
    return this.downloadAppointmentPdf(document.path, document.timestamp, document.hash, operation, document.informationSheet);
  }

  async listPrescriptions(options: PrescriptionListOptions = {}): Promise<ReadResult<Prescription[]>> {
    if (options.status !== undefined && !["all", "valid", "history", "purchased", "expired", "renewable"].includes(options.status)) throw new TypeError("unsupported prescription status selection");
    if (options.permanent !== undefined && typeof options.permanent !== "boolean") throw new TypeError("permanent must be a boolean");
    const operation = "prescriptions";
    const data = object(await json(this.transport, this.path("MedicalFileAPI", "v1", "prescriptions"), operation, this.post({ members: [this.member()] })), operation);
    const rows = this.rows(data.results, operation);
    for (const row of rows) for (const field of ["doc_id", "drug_name", "drug_instructions", "from_date", "to_date"]) string(row[field], operation);
    this.prescriptionReferences.clear();
    for (const row of rows) {
      const key = row.doc_id as string;
      this.prescriptionReferences.set(key, [...(this.prescriptionReferences.get(key) ?? []), structuredClone(row)]);
    }
    const filtered = rows.filter(row => {
      if (options.permanent !== undefined && typeof row.is_permanent_drug !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
      if (options.status !== undefined && options.status !== "all" && (!Number.isSafeInteger(row.purchase_status) || ![1, 2, 3, 4, 5, 6, 7].includes(row.purchase_status as number))) throw new ReadOperationError("INVALID_RESPONSE", operation);
      if (options.status === "renewable" && typeof row.is_prescription_renewal !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
      if (options.permanent !== undefined && row.is_permanent_drug !== options.permanent) return false;
      switch (options.status) {
        case "valid": return [1, 2, 3, 7].includes(row.purchase_status as number);
        case "history": return [4, 5, 6].includes(row.purchase_status as number);
        case "purchased": return [4, 5].includes(row.purchase_status as number);
        case "expired": return row.purchase_status === 6;
        case "renewable": return row.is_prescription_renewal === true && [4, 5, 6].includes(row.purchase_status as number);
        default: return true;
      }
    });
    const projected = filtered.map(row => {
      const copy = structuredClone(row);
      for (const field of ["file_link", "hash", "timestamp"]) delete copy[field];
      if (row.drug_largo_code !== undefined && row.drug_largo_code !== null) {
        if (typeof row.drug_largo_code !== "string" || !/^[1-9]\d{0,31}$/.test(row.drug_largo_code)) throw new ReadOperationError("INVALID_RESPONSE", operation);
        copy.medicine_info_link = `https://www.maccabi4u.co.il/healthguide/medicines/תרופות/${row.drug_largo_code}`;
      }
      return copy as Prescription;
    });
    const result = this.result(projected, "MedicalFileAPI", operation);
    if ((options.status !== undefined && options.status !== "all") || options.permanent !== undefined) result.source.completeness = "local-filtered-subset";
    return result;
  }

  async getPrescriptionPdf(docId: string): Promise<ReadResult<Uint8Array>> {
    const operation = "prescription-pdf";
    if (!this.prescriptionReferences.size) await this.listPrescriptions();
    const rows = this.prescriptionReferences.get(docId);
    if (!rows || rows.length !== 1) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const row = rows[0]!;
    if (row.is_digital_prescription !== true || ![1, 2, 3].includes(row.purchase_status as number)) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const query = new URLSearchParams({ timestamp: string(row.timestamp, operation), hash: decodeSourceQueryComponent(row.hash, operation), data: string(row.doc_id, operation), path: string(row.file_link, operation) });
    return this.downloadSourcePdf(`${this.path("MedicalFileAPI", "v1", "getprescriptionpdf")}?${query}`, "MedicalFileAPI", operation);
  }

  /** Alternatives displayed for a fresh, currently purchasable owner prescription. */
  async listPrescriptionAlternatives(docId: string): Promise<ReadResult<{largo_code: string | number; name: string}[]>> {
    const operation = "prescription-alternatives";
    if (typeof docId !== "string" || !docId || docId.length > 512) throw new ReadOperationError("OWNER_MISMATCH", operation);
    await this.listPrescriptions();
    const matches = this.prescriptionReferences.get(docId);
    if (matches?.length !== 1) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const prescription = matches[0]!;
    if (![1, 2, 3].includes(prescription.purchase_status as number)) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const query = new URLSearchParams({ largoCode: string(prescription.drug_largo_code, operation) });
    const data = object(await json(this.transport, `${this.path("MedicalFileAPI", "v1", "alternativeDrugs")}?${query}`, operation), operation);
    assertRecordOwner(data, this.owner, operation);
    const drugs = this.rows(data.drugs, operation);
    if (drugs.length > 1000) throw new ReadOperationError("INVALID_RESPONSE", operation);
    const seen = new Set<string>();
    const projected = drugs.map(drug => {
      const code = drug.largo_code;
      if (!((typeof code === "string" && code.length > 0 && code.length <= 512) || (typeof code === "number" && Number.isSafeInteger(code)))) throw new ReadOperationError("INVALID_RESPONSE", operation);
      if (seen.has(String(code))) throw new ReadOperationError("INVALID_RESPONSE", operation);
      seen.add(String(code));
      const name = string(drug.name, operation);
      if (!name || name.length > 16384) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return { largo_code: code, name };
    });
    const result = this.result(projected, "MedicalFileAPI", operation);
    result.source.schemaEvidence = "frontend-field-projection";
    return result;
  }

  /** Homepage omits dates via literal undefined; referrals page sends YYYY-MM-DD bounds. */
  async listReferrals(range?: DateRange): Promise<ReadResult<Referral[]>> {
    const operation = "referrals";
    if (range) validateDateRange(range);
    const query = new URLSearchParams({ from_date: range?.from ?? "undefined", to_date: range?.to ?? "undefined" });
    const data = object(await json(this.transport, `${this.path("MedicalFileAPI", "v1", "referrals")}?${query}`, operation), operation);
    const rows = this.rows(data.referrals, operation);
    for (const row of rows) for (const field of ["referral_id", "referral_date", "displaying_name", "pdf_link"]) string(row[field], operation);
    this.referralReferences.clear();
    for (const row of rows) this.referralReferences.set(row.referral_id as string, structuredClone(row) as Referral);
    return this.result(rows as Referral[], "MedicalFileAPI", operation);
  }

  /** Owner list with source-rendered fields; populated rows remain frontend-projection evidence. */
  async listFutureAppointments(): Promise<ReadResult<FutureAppointment[]>> {
    const operation = "future-appointments";
    const data = await json(this.transport, this.path("AppointmentOrderAPI", "v2", "appointments/future"), operation,
      this.post({ members: [{ ...this.member(), member_consent_for_subsidiary_information: 0 }], is_with_ascribed_doctor: true }));
    const rows = this.rows(data, operation);
    try {
      const result = this.result(projectFutureAppointments(rows), "AppointmentOrderAPI", operation);
      const references = new Map<string, SourceRecord>();
      rows.forEach((row, index) => {
        const reference = this.futureAppointmentReference(row);
        if (!reference) return;
        if (references.has(reference)) throw new ReadOperationError("INVALID_RESPONSE", operation);
        references.set(reference, structuredClone(row));
        result.data[index]!.reference = reference;
      });
      this.futureAppointmentRecords.clear();
      for (const [reference, row] of references) this.futureAppointmentRecords.set(reference, row);
      result.source.schemaEvidence = "frontend-field-projection";
      return result;
    } catch (error) {
      if (error instanceof FutureAppointmentContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
  }

  private futureAppointmentReference(row: SourceRecord): string | undefined {
    // Subsidiary detail has its own UI branch and is not implied by this owner list.
    if (row.subsidiary_name) return undefined;
    const scalar = (value: unknown): boolean => typeof value === "string" && value.length > 0 || typeof value === "number" && Number.isSafeInteger(value);
    if (typeof row.object_type !== "string" || !row.object_type || !scalar(row.object_id) || !scalar(row.employee_id) || !scalar(row.type)) return undefined;
    if (row.employee_id === 0 && !scalar(row.provider_id)) return undefined;
    for (const field of ["id", "external_id", "provider_id"]) if (row[field] !== undefined && row[field] !== null && row[field] !== "" && !scalar(row[field])) return undefined;
    return createHash("sha256").update(JSON.stringify([row.id ?? null, row.external_id ?? null, row.object_type, row.object_id, row.date, row.employee_id, row.provider_id ?? null, row.type])).digest("hex");
  }

  /** Normal owner appointment detail only: provider/contact and visit-instruction reads, no scheduling dialogue. */
  async getFutureAppointment(reference: string): Promise<ReadResult<FutureAppointmentDetail>> {
    const operation = "future-appointment";
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    await this.listFutureAppointments();
    const appointment = this.futureAppointmentRecords.get(reference);
    if (!appointment) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const providerReference = { object_type: appointment.object_type, object_id: appointment.object_id,
      ...(appointment.employee_id === 0 ? { provider_id: appointment.provider_id === 0 ? null : appointment.provider_id } : { employee_id: appointment.employee_id }) };
    const response = object(await json(this.transport, this.path("MainAppAPI", "v1", "providers"), operation,
      this.post({ service_providers: [providerReference], retrieval_type: "1" })), operation);
    const providers = this.rows(object(response.providers, operation).provider, operation);
    if (providers.length !== 1) throw new ReadOperationError("INVALID_RESPONSE", operation);
    const provider = providers[0]!;
    if (provider.sap_key !== undefined && provider.sap_key !== null) {
      const sap = object(provider.sap_key, operation);
      if (String(sap.object_type) !== String(appointment.object_type) || String(sap.object_Id) !== String(appointment.object_id) || appointment.employee_id !== 0 && String(sap.employee_id) !== String(appointment.employee_id)) throw new ReadOperationError("INVALID_RESPONSE", operation);
    }
    const instructions = object(await json(this.transport, this.path("AppointmentOrderAPI", "v1", "appointments/instructions_for_visit_type"), operation,
      this.post({ object_type: appointment.object_type, object_id: appointment.object_id, employee_id: appointment.object_type === "O" ? 0 : appointment.employee_id, chosenVisitType: appointment.type })), operation);
    assertRecordOwner(instructions, this.owner, operation);
    try {
      const result = this.result(projectFutureAppointmentDetail(appointment, provider, instructions), "AppointmentOrderAPI+MainAppAPI", operation);
      result.source.schemaEvidence = "frontend-field-projection";
      return result;
    } catch (error) {
      if (error instanceof FutureAppointmentDetailContentError || error instanceof FutureAppointmentContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
  }

  /** asOf is the portal's timezone-free YYYY-MM-DDTHH:mm:ss text. No timezone conversion is inferred. */
  async getAscribedProvider(asOf: string): Promise<ReadResult<SourceRecord>> {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}Z`)) || new Date(`${asOf}Z`).toISOString().slice(0, 19) !== asOf) throw new TypeError("asOf must be YYYY-MM-DDTHH:mm:ss");
    const operation = "ascribed-provider";
    const query = new URLSearchParams({ requested_association_date: asOf });
    const data = object(await json(this.transport, `${this.path("AppointmentOrderAPI", "v1", "providers/ascribed")}?${query}`, operation), operation);
    for (const field of ["first_name", "last_name", "service_provider_id"]) string(data[field], operation);
    return this.result(data, "AppointmentOrderAPI", operation);
  }
  /** Observed adult-owner recent-provider list; arbitrary service-directory search is not implemented. */
  async listRecentProviders(): Promise<ReadResult<RecentProvider[]>> {
    const operation = "recent-providers";
    const age = object(this.appointmentOwnerData.age, operation);
    if (typeof age.years !== "number" || age.years < 18) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const rows = this.rows(await json(this.transport, `${this.path("AppointmentOrderAPI", "v1", "providers/appointment_service_providers")}?is_minor=false`, operation), operation);
    for (const row of rows) {
      for (const key of ["object_type", "object_id", "employee_id", "pactitioner_name_title", "practitioner_id"]) string(row[key], operation);
      object(row.clinic_address, operation);
    }
    this.providerReferences.clear();
    for (const row of rows) this.providerReferences.set(this.providerKey(row as unknown as ProviderReference), structuredClone(row) as RecentProvider);
    return this.result(rows as RecentProvider[], "AppointmentOrderAPI", operation);
  }

  async checkAppointmentEligibility(reference: ProviderReference): Promise<ReadResult<SourceRecord>> {
    const operation = "appointment-eligibility";
    const provider = await this.resolveProvider(reference, operation);
    const data = object(await json(this.transport, this.path("AppointmentOrderAPI", "v1", "appointments/eligibility"), operation,
      this.post({ ...this.reference(provider), action_type: 1 })), operation);
    if (typeof data.is_eligible !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
    this.rows(data.future_appointments, operation);
    return this.result(data, "AppointmentOrderAPI", operation);
  }

  async getAppointmentProvider(reference: ProviderReference): Promise<ReadResult<SourceRecord>> {
    const operation = "appointment-provider";
    const provider = await this.resolveProvider(reference, operation);
    const data = object(await json(this.transport, this.path("MainAppAPI", "v1", "providers"), operation,
      this.post({ service_providers: [{ object_type: provider.object_type, object_id: provider.object_id, ...(provider.employee_id && provider.employee_id !== "0" ? { employee_id: provider.employee_id } : {}) }], retrieval_type: "1" })), operation);
    const rows = this.rows(object(data.providers, operation).provider, operation);
    if (rows.length !== 1) throw new ReadOperationError("INVALID_RESPONSE", operation);
    const row = rows[0]!;
    for (const key of ["provider_id", "facility_id", "provider_role"]) string(row[key], operation);
    const sap = object(row.sap_key, operation);
    if (sap.object_type !== provider.object_type || sap.object_Id !== provider.object_id || sap.employee_id !== provider.employee_id) throw new ReadOperationError("INVALID_RESPONSE", operation);
    return this.result(row, "MainAppAPI", operation);
  }

  /** Stops at the first clinic availability response. Never sends dates, times, booking or change responses. */
  async getClinicAvailability(reference: ProviderReference): Promise<ReadResult<ClinicAvailability>> {
    const operation = "clinic-availability";
    const eligibility = await this.checkAppointmentEligibility(reference);
    if (eligibility.data.is_eligible !== true) throw new ReadOperationError("NOT_ELIGIBLE", operation);
    if ((eligibility.data.future_appointments as unknown[]).length !== 0) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const provider = (await this.getAppointmentProvider(reference)).data;
    const authentication = await this.getAppointmentAuthentication();
    const phones = this.rows(this.appointmentOwnerData.phones, operation);
    const phone = (type: string) => {
      const item = phones.filter((row) => row.phone_type === type).at(-1);
      if (!item) return "";
      if (typeof item.phone_prefix !== "string" || typeof item.phone_no !== "number") throw new ReadOperationError("INVALID_RESPONSE", operation);
      return `${item.phone_prefix}-${item.phone_no}`;
    };
    const start = object(await json(this.transport, this.path("AppointmentOrderAPI", "v1", "odoro/session"), operation,
      this.post({ move_event_id: "0", authentication, provider_id: provider.provider_id, facility_code: provider.facility_id, provider_role: provider.provider_role,
        member_phone: phone("ב"), member_other_phone: phone("נ"), member_first_name: this.profile.f_name_hebrew, member_last_name: this.profile.l_name_hebrew })), operation);
    const request = object(start.request, operation);
    // Exact observed clinic-mode choice only. A changed or more complex dialogue is unsupported.
    if ((Object.hasOwn(start, "appointment_id") && start.appointment_id !== null) || request["@type"] !== "options" || request.appoint != null || request.end != null) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const options = this.rows(object(request.options, operation).opt, operation);
    const clinic = options.filter((row) => row.code === "2" && row.description === "תור במרפאה");
    if (clinic.length !== 1) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const sessionId = string(start.session_id, operation);
    if (!sessionId) throw new ReadOperationError("INVALID_RESPONSE", operation);
    const data = object(await json(this.transport, this.path("AppointmentOrderAPI", "v1", "odoro/dialog"), operation,
      this.post({ session_id: sessionId, authentication, response: "2" })), operation);
    const next = object(data.request, operation);
    if (data.appointment_id !== null || next["@type"] !== "appoint" || next.end != null) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const appoint = object(next.appoint, operation);
    const rawMonths = object(appoint.months, operation);
    const months = { view_month: string(rawMonths.view_month, operation), first_month: string(rawMonths.first_month, operation), last_month: string(rawMonths.last_month, operation) };
    const days = this.rows(object(appoint.days, operation).day, operation).map((day) => {
      const dayDate = string(day.dayDate, operation);
      const times = object(day.times, operation).time;
      if (!Array.isArray(times) || !times.every((value) => typeof value === "string")) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return { dayDate, times: times as string[] };
    });
    if (!Array.isArray(data.message) || !data.message.every((value) => typeof value === "string")) throw new ReadOperationError("INVALID_RESPONSE", operation);
    return this.result({ months, days, messages: data.message as string[], mode: "clinic" }, "AppointmentOrderAPI", operation);
  }

  private providerKey(reference: ProviderReference): string { return JSON.stringify([reference.object_type, reference.object_id, reference.employee_id]); }
  private reference(provider: ProviderReference): ProviderReference { return { object_type: provider.object_type, object_id: provider.object_id, employee_id: provider.employee_id }; }
  private async resolveProvider(reference: ProviderReference, operation: string): Promise<RecentProvider> {
    for (const key of ["object_type", "object_id", "employee_id"] as const) string(reference[key], operation);
    const key = this.providerKey(reference);
    if (!this.providerReferences.has(key)) await this.listRecentProviders();
    const provider = this.providerReferences.get(key);
    if (!provider) throw new ReadOperationError("OWNER_MISMATCH", operation);
    return provider;
  }
  private async getAppointmentAuthentication(): Promise<string> {
    if (this.#appointmentAuthentication) return this.#appointmentAuthentication;
    const operation = "appointment-source";
    // Exact public static asset observed in S4 record426. No source is evaluated or executed.
    const response = await this.transport.request("/sonline/appointmentOrder/static/js/async/467.5c814e7c.js", { apiAuthorization: false });
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/javascript" && contentType !== "text/javascript") { await discard(response); throw new ReadOperationError("UNSUPPORTED_FLOW", operation); }
    const source = await readResponseBody(() => response.text(), new ReadOperationError("INVALID_RESPONSE", operation));
    if (source.length > 8_000_000 || !source.includes("/odoro/session") || !source.includes("/odoro/dialog")) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const matches = [...source.matchAll(/\b[A-Za-z_$][\w$]*="\/sonline\/AppointmentOrderAPI\/webapi\/mac\/",[A-Za-z_$][\w$]*="([a-f0-9]{32})"/g)];
    if (matches.length !== 1) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    this.#appointmentAuthentication = matches[0]![1]!;
    return this.#appointmentAuthentication;
  }

  async listVisits(): Promise<ReadResult<VisitSummary[]>> {
    const operation = "visits";
    const data = object(await json(this.transport, this.path("AppointmentOrderAPI", "v1", "visits/history"), operation,
      this.post({ members: [this.member()] })), operation);
    const rows = this.rows(data.results, operation);
    for (const row of rows) {
      for (const field of ["appointment_id", "appointment_date", "service_provider_name", "service_name"]) string(row[field], operation);
      if (typeof row.has_summery_file !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
    }
    this.visitReferences.clear();
    for (const row of rows) if (row.has_summery_file) this.visitReferences.add(row.appointment_id as string);
    return this.result(rows as VisitSummary[], "AppointmentOrderAPI", operation);
  }

  async getVisit(appointmentId: string): Promise<ReadResult<SourceRecord>> {
    const operation = "visit";
    if (!this.visitReferences.has(appointmentId)) {
      const matches = (await this.listVisits()).data.filter(row => row.appointment_id === appointmentId);
      if (!this.visitReferences.has(appointmentId)) throw new ReadOperationError(matches.length ? "UNSUPPORTED_FLOW" : "OWNER_MISMATCH", operation);
    }
    const data = object(await json(this.transport, this.path("AppointmentOrderAPI", "v1", `visits/${encodeURIComponent(appointmentId)}`), operation), operation);
    assertRecordOwner(data, this.owner, operation);
    for (const field of ["member_id", "member_id_code", "visit_summary_date", "service_provider_name", "visit_summary_pdf_link"]) string(data[field], operation);
    const {projected,documents} = this.projectAppointmentDocuments(data, appointmentId, operation);
    this.visitPdfRecords.set(appointmentId, structuredClone(data));
    this.visitDocumentRecords.set(appointmentId, documents);
    return this.result(projected, "AppointmentOrderAPI", operation);
  }

  private projectAppointmentDocuments(data: SourceRecord, selectionKey: string, operation: string): {projected: SourceRecord; documents: Map<string,AppointmentDocument>} {
    const projected = structuredClone(data);
    projected.has_summary_pdf = typeof data.visit_summary_pdf_link === "string" && data.visit_summary_pdf_link.length > 0;
    for (const field of ["visit_summary_pdf_link", "timestamp", "hash"]) delete projected[field];
    const documents = new Map<string, AppointmentDocument>();
    for (const [collection, pathField] of [["drugs", "prescription_pdf_link"], ["referrals", "referral_pdf_link"], ["approvals", "approval_pdf_link"], ["tutorials", "item_url"]] as const) {
      if (data[collection] === undefined || data[collection] === null) continue;
      projected[collection] = this.rows(data[collection], operation).map((row, index) => {
        const copy = structuredClone(row);
        for (const field of [pathField, "timestamp", "hash"]) delete copy[field];
        if (collection === "tutorials" && (row.type_id === 2 || row.type_id === 3)) {
          const raw = string(row.item_url, operation);
          if (!raw || raw.length > 16384) throw new ReadOperationError("INVALID_RESPONSE", operation);
          let link: string;
          try { link = decodeURIComponent(raw); } catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
          if (link.length > 4096 || /[\u0000-\u001f\u007f]/.test(link)) throw new ReadOperationError("INVALID_RESPONSE", operation);
          let target: URL;
          try { target = new URL(link); } catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
          if (!["http:","https:"].includes(target.protocol) || target.username || target.password) throw new ReadOperationError("INVALID_RESPONSE", operation);
          copy.link = link;
        }
        const eligible = collection === "drugs" ? row.prescription_is_digital === 1 && row.rescription_cancellation_status !== 1 : collection !== "tutorials" || row.type_id === 1;
        const path = row[pathField];
        if (eligible && typeof path === "string" && path.length > 0) {
          // The frontend binds each action to its array row. This is a current-detail
          // selection key; reordering or changed routing requires a fresh reference.
          const reference = createHash("sha256").update(JSON.stringify([selectionKey, collection, index, path])).digest("hex");
          documents.set(reference, { path, timestamp: row.timestamp, hash: row.hash, informationSheet: collection === "tutorials" });
          copy.pdf_reference = reference;
        }
        return copy;
      });
    }
    return {projected,documents};
  }

  /** Source-rendered prescription, referral, approval or type-1 information PDF from a fresh owner visit. */
  async getVisitDocumentPdf(appointmentId: string, reference: string): Promise<ReadResult<Uint8Array>> {
    const operation = "visit-document-pdf";
    if (typeof appointmentId !== "string" || !appointmentId || !/^[a-f0-9]{64}$/.test(reference)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const matches = (await this.listVisits()).data.filter(row => row.appointment_id === appointmentId);
    if (matches.length !== 1) throw new ReadOperationError(matches.length ? "INVALID_RESPONSE" : "OWNER_MISMATCH", operation);
    if (!matches[0]!.has_summery_file) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    await this.getVisit(appointmentId);
    const document = this.visitDocumentRecords.get(appointmentId)?.get(reference);
    if (!document) throw new ReadOperationError("OWNER_MISMATCH", operation);
    return this.downloadAppointmentPdf(document.path, document.timestamp, document.hash, operation, document.informationSheet);
  }

  /** Original visit summary PDF, resolved from a fresh unique owner history row and detail. */
  async getVisitSummaryPdf(appointmentId: string): Promise<ReadResult<Uint8Array>> {
    const operation = "visit-summary-pdf";
    const matches = (await this.listVisits()).data.filter(row => row.appointment_id === appointmentId);
    if (matches.length !== 1) throw new ReadOperationError(matches.length ? "INVALID_RESPONSE" : "OWNER_MISMATCH", operation);
    if (!matches[0]!.has_summery_file) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    await this.getVisit(appointmentId);
    const row = this.visitPdfRecords.get(appointmentId);
    if (!row || typeof row.visit_summary_pdf_link !== "string" || !row.visit_summary_pdf_link) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    return this.downloadAppointmentPdf(row.visit_summary_pdf_link, row.timestamp, row.hash, operation);
  }

  /** Source sr/eS interpolates signatures directly; only the private path is URI-encoded. */
  private async downloadAppointmentPdf(pathValue: unknown, timestampValue: unknown, hashValue: unknown, operation: string, informationSheet = false): Promise<ReadResult<Uint8Array>> {
    const path = string(pathValue, operation);
    if (!path || path.length > 16384) throw new ReadOperationError("INVALID_RESPONSE", operation);
    const component = (value: unknown): string => {
      const raw = string(value, operation);
      if (!raw || raw.length > 8192 || /[&#?=\u0000-\u0020\u007f]/.test(raw) || /%(?![0-9a-fA-F]{2})/.test(raw)) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return raw;
    };
    let encodedPath: string;
    try { encodedPath = encodeURIComponent(path); } catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
    const service = informationSheet ? "MedicalFileAPI" : "AppointmentOrderAPI";
    const query = `${informationSheet ? "url" : "path"}=${encodedPath}&timestamp=${component(timestampValue)}&hash=${component(hashValue)}`;
    return this.downloadSourcePdf(`${this.path(service, informationSheet ? "v2" : "v1", "pdf")}?${query}`, service, operation, 2 * 1024 * 1024);
  }

  /** Downloads only a PDF reference obtained from this owner's referral list. Does not mark it read. */
  async getReferralPdf(referralId: string): Promise<ReadResult<Uint8Array>> {
    const operation = "referral-pdf";
    if (!this.referralReferences.has(referralId)) await this.listReferrals();
    const referral = this.referralReferences.get(referralId);
    if (!referral) throw new ReadOperationError("OWNER_MISMATCH", operation);
    return this.downloadMedicalFilePdf(referral, operation);
  }

  private async downloadSourcePdf(input: string, service: string, operation: string, maxBytes: number = PDF_BYTE_LIMIT): Promise<ReadResult<Uint8Array>> {
    const requested = new URL(input, PORTAL_ORIGIN);
    const response = await this.transport.request(input, { apiAuthorization: false });
    const finalUrl = new URL(response.url || input, PORTAL_ORIGIN);
    if (finalUrl.origin === "https://mac.maccabi4u.co.il" || ["/my.logout.php3", "/my.policy", "/mac/login"].includes(finalUrl.pathname.toLowerCase())) { await discard(response); throw new ReauthenticationRequired(response.status); }
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    if (finalUrl.origin !== PORTAL_ORIGIN || finalUrl.pathname !== requested.pathname || finalUrl.search !== requested.search || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/pdf") { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) { await discard(response); throw new ReadOperationError("INVALID_RESPONSE", operation); }
    const bytes = await readCappedBody(response, maxBytes, new ReadOperationError("INVALID_RESPONSE", operation));
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new ReadOperationError("INVALID_RESPONSE", operation);
    return this.result(bytes, service, operation);
  }

  private async downloadMedicalFilePdf(record: SourceRecord, operation: string): Promise<ReadResult<Uint8Array>> {
    let path: string, hash: string;
    try { path = decodeURIComponent(string(record.pdf_link, operation)); hash = decodeURIComponent(string(record.hash, operation)); }
    catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
    const query = new URLSearchParams({ path, timestamp: string(record.timestamp, operation), hash });
    const response = await this.transport.request(`${this.path("MedicalFileAPI", "v1", "pdf")}?${query}`, { apiAuthorization: false });
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    const bytes = await readCappedBody(response, PDF_BYTE_LIMIT, new ReadOperationError("INVALID_RESPONSE", operation));
    if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/pdf" || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new ReadOperationError("INVALID_RESPONSE", operation);
    return this.result(bytes, "MedicalFileAPI", operation);
  }

  /** Captured default test list includes laboratory and other results; no server date paging is established. */
  async listTests(options: TestListOptions = {}): Promise<ReadResult<{ categories: SourceRecord[]; tests: TestSummary[] }>> {
    const operation = "tests";
    if (options.year !== undefined && (!Number.isInteger(options.year) || options.year < 1000 || options.year > 9999)) throw new TypeError("year must be a four-digit integer");
    const data = object(await json(this.transport, this.path("TestResultsAPI", "v1", "tests"), operation,
      this.post({ members: [], categories: [], logged_user_gender: this.profile.sex, current_user_gender: this.profile.sex })), operation);
    const tests = this.rows(data.tests, operation);
    const categories = this.rows(data.categories, operation);
    for (const row of tests) {
      for (const field of ["request_id", "doc_id", "type", "execute_date", "result_date"]) string(row[field], operation);
      if (!Array.isArray(row.test_name) || !row.test_name.every((name) => typeof name === "string")) throw new ReadOperationError("INVALID_RESPONSE", operation);
      // Same predicate the document download gates on, so a caller can tell which rows are fetchable
      // without calling the download on every candidate and reading the failures.
      row.has_document = hasSourceDocument(row);
    }
    // Remember only source references from a completely validated owner-only response.
    this.testReferences.clear();
    for (const row of tests) this.testReferences.set(JSON.stringify([row.request_id, row.doc_id]), structuredClone(row));
    const filtered = options.year === undefined ? tests : tests.filter((row) => {
      const date = row.execute_date as string;
      // Captured execution dates are timezone-free ISO text. Compare the written calendar year.
      // A malformed or new format is an error, not a silently omitted medical record.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}Z`)) || new Date(`${date}Z`).toISOString().slice(0, 19) !== date) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return Number(date.slice(0, 4)) === options.year;
    });
    const result = this.result({ categories, tests: filtered as TestSummary[] }, "TestResultsAPI", operation);
    if (options.year !== undefined) result.source = { ...result.source, completeness: "local-filtered-subset", selection: { mode: "local", field: "execute_date", year: options.year } };
    return result;
  }

  /**
   * Original document behind one source-listed test row, whatever the row's type. Does not mark it read.
   * Ownership and fetchability are separate questions: the pair must name a row of this owner's own list,
   * and that row must carry an attached document. Rows without one (laboratory results, which have their
   * own report flow, and imaging studies, which the source opens in a viewer) fail as an unsupported flow.
   */
  async getImagingResultPdf(requestId: string, docId: string): Promise<ReadResult<Uint8Array>> {
    const operation = "imaging-result-pdf";
    const key = JSON.stringify([requestId, docId]);
    if (!this.testReferences.has(key)) await this.listTests();
    const record = this.testReferences.get(key);
    if (!record) throw new ReadOperationError("OWNER_MISMATCH", operation);
    if (!hasSourceDocument(record)) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const gender = this.profile.sex === "נ" ? "2" : "1";
    const query = new URLSearchParams({ memberidcode: this.owner.memberIdCode, memberid: String(this.owner.memberId), data: string(record.doc_id, operation), t: string(record.time_stamp, operation), hash: decodeSourceQueryComponent(record.hash, operation), loggedInUserGender: gender, currentUsergender: gender, memberIdForHeader: String(this.owner.memberId), memberIdCodeForHeader: this.owner.memberIdCode });
    const response = await this.transport.request(`/sonline/TestResultsAPI/webapi/mac/pdf/openfile?${query}`, { apiAuthorization: false });
    if (!response.ok) { await discard(response); throw new ReadOperationError("UPSTREAM_HTTP", operation, response.status); }
    const bytes = await readCappedBody(response, PDF_BYTE_LIMIT, new ReadOperationError("INVALID_RESPONSE", operation));
    if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/pdf" || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new ReadOperationError("INVALID_RESPONSE", operation);
    return this.result(bytes, "TestResultsAPI", operation);
  }

  /**
   * The owner's imaging studies, taken out of the same test list every other row comes from. The
   * `request_id` on one of these rows *is* the DICOM Study Instance UID the viewer addresses: it was
   * compared byte-for-byte against a live handoff, and it is the only DICOM-UID-shaped string in the
   * whole test-list response. That is what makes the viewer reads ownership-bound at all.
   */
  async listImagingStudies(): Promise<ReadResult<TestSummary[]>> {
    const operation = "imaging-studies";
    const listed = await this.listTests();
    return { ...listed, data: listed.data.tests.filter(row => row.type === "imaging_study"), source: { ...listed.source, operation, completeness: "local-filtered-subset" } };
  }

  /**
   * The study's series and instances, read from the MedDream viewer after walking the handoff chain.
   * The response names the patient at its top level, so it is only safe to print or hand to a model
   * through `safeClinical`, which both surfaces of this project apply to every result.
   */
  async getImagingStudy(studyInstanceUID: string): Promise<ReadResult<ImagingStudyStructure>> {
    const operation = "imaging-study";
    const session = await this.imagingViewer(studyInstanceUID, operation);
    return this.result(await this.viewerRead(() => readStudyStructure(this.transport, session), operation), "MedDream", operation);
  }

  /** DICOM fields for one instance, including the geometry `/pixels` needs and does not carry. */
  async getImagingImage(studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string): Promise<ReadResult<ImagingImageMetadata>> {
    const operation = "imaging-image";
    const session = await this.imagingInstance(studyInstanceUID, seriesInstanceUID, sopInstanceUID, operation);
    return this.result(await this.viewerRead(() => readImageMetadata(this.transport, session, seriesInstanceUID, sopInstanceUID), operation), "MedDream", operation);
  }

  /** The server-rendered preview JPEG for one instance. Not DICOM, and not the diagnostic image. */
  async getImagingImageThumbnail(studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string): Promise<ReadResult<Uint8Array>> {
    const operation = "imaging-thumbnail";
    const session = await this.imagingInstance(studyInstanceUID, seriesInstanceUID, sopInstanceUID, operation);
    return this.result(await this.viewerRead(() => readImageThumbnail(this.transport, session, seriesInstanceUID, sopInstanceUID), operation), "MedDream", operation);
  }

  /**
   * The raw pixel buffer and the numbers that make it readable. There is deliberately no way to ask
   * for the bytes alone: the response has no header, so without the metadata it is an undifferentiated
   * block that cannot even be checked for truncation. The metadata read happens here, and its
   * arithmetic is verified against the actual byte length before anything is returned.
   */
  async getImagingImagePixels(studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string): Promise<ReadResult<ImagingPixels>> {
    const operation = "imaging-pixels";
    const session = await this.imagingInstance(studyInstanceUID, seriesInstanceUID, sopInstanceUID, operation);
    return this.result(await this.viewerRead(async () => {
      const metadata = await readImageMetadata(this.transport, session, seriesInstanceUID, sopInstanceUID);
      return readImagePixels(this.transport, session, seriesInstanceUID, sopInstanceUID, metadata);
    }, operation), "MedDream", operation);
  }

  /**
   * Ownership, then the handoff. The study UID must name exactly one row of this owner's freshly
   * listed imaging studies - and note the asymmetry with the document downloads: those bind the
   * (request_id, doc_id) pair and reject a cross-row combination, while the viewer URL takes
   * request_id alone, so this degrades to a single-field check. It is still the only thing standing
   * between a caller-supplied UID and a third party's study, because nothing in the capture says
   * whether MedDream binds its own session to the studies it handed out.
   */
  private async imagingViewer(studyInstanceUID: string, operation: string): Promise<ImagingViewerSession> {
    if (typeof studyInstanceUID !== "string" || !studyInstanceUID) throw new TypeError("studyInstanceUID must be a nonempty string");
    const matches = (await this.listImagingStudies()).data.filter(row => row.request_id === studyInstanceUID);
    if (matches.length !== 1) throw new ReadOperationError(matches.length ? "INVALID_RESPONSE" : "OWNER_MISMATCH", operation);
    const existing = this.#imagingViewers.get(studyInstanceUID);
    if (existing) return existing;
    const checksumId = this.#checksumId;
    if (!checksumId) throw new ReadOperationError("TOKEN_UNAVAILABLE", operation);
    const session = await this.viewerRead(() => openImagingViewer(this.transport, handoffPath(this.owner, checksumId, studyInstanceUID), studyInstanceUID), operation);
    this.#imagingViewers.set(studyInstanceUID, session);
    return session;
  }

  /** A series and instance the study's own fresh structure lists; a foreign UID never reaches a URL. */
  private async imagingInstance(studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string, operation: string): Promise<ImagingViewerSession> {
    const session = await this.imagingViewer(studyInstanceUID, operation);
    const structure = await this.viewerRead(() => readStudyStructure(this.transport, session), operation);
    const found = structure.series.filter(series => series.seriesInstanceUID === seriesInstanceUID)
      .flatMap(series => series.instances.filter(instance => instance.sopInstanceUID === sopInstanceUID));
    if (found.length !== 1) throw new ReadOperationError(found.length ? "INVALID_RESPONSE" : "OWNER_MISMATCH", operation);
    return session;
  }

  /** The viewer module speaks a subset of the read codes, so it only needs the operation name here. */
  private async viewerRead<T>(work: () => Promise<T>, operation: string): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof ImagingViewerError) throw new ReadOperationError(error.code, operation, error.status);
      throw error;
    }
  }

  /** Current owner's latest result for each laboratory test, as grouped by the service. */
  async listLatestLabResults(): Promise<ReadResult<LatestLabResultGroup[]>> {
    const operation = "latest-lab-results";
    const data = object(await json(this.transport, this.path("TestResultsAPI", "v1", "getlatestlabresults"), operation), operation);
    assertRecordOwner(data, this.owner, operation);
    for (const group of this.rows(data.results, operation)) this.rows(group.group_values, operation);
    try {
      const groups = projectLatestLabResults(data.results);
      string(data.time_stamp, operation); string(data.hash, operation);
      this.latestLabMetadata = structuredClone(data);
      return this.result(groups, "TestResultsAPI", operation);
    } catch (error) {
      if (error instanceof LatestLabResultContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
  }

  /** Original unfiltered latest-results report, using fresh owner metadata and the UI print flags. */
  async getLatestLabResultsPdf(options: LabReportOptions = {}): Promise<ReadResult<Uint8Array>> {
    const operation = "latest-lab-results-pdf";
    if (options.irregularOnly !== undefined && typeof options.irregularOnly !== "boolean") throw new TypeError("irregularOnly must be a boolean");
    await this.listLatestLabResults();
    const data = this.latestLabMetadata!;
    const query = new URLSearchParams({ t: string(data.time_stamp, operation), hash: decodeSourceQueryComponent(data.hash, operation), irregular_only: String(options.irregularOnly ?? false), is_attachment: "false" });
    return this.downloadSourcePdf(`${this.path("TestResultsAPI", "v1", "getlatestlabresults/report")}?${query}`, "TestResultsAPI", operation, 2 * 1024 * 1024);
  }

  /** Existing tracking selection only; never adds or removes followed tests. */
  async listFollowedLabResults(): Promise<ReadResult<FollowedLabResults>> {
    const operation = "followed-lab-results";
    const data = object(await json(this.transport, this.path("TestResultsAPI", "v1", "followed"), operation), operation);
    assertRecordOwner(data, this.owner, operation);
    this.rows(data.followed_tests, operation); this.rows(data.options, operation);
    try {
      const projected = projectFollowedLabResults(data);
      this.followedLabMetadata = structuredClone(data);
      const result = this.result(projected, "TestResultsAPI", operation);
      result.source.schemaEvidence = "frontend-field-projection";
      return result;
    } catch (error) {
      if (error instanceof LatestLabResultContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
  }

  async getFollowedLabResultsPdf(): Promise<ReadResult<Uint8Array>> {
    const operation = "followed-lab-results-pdf";
    await this.listFollowedLabResults();
    const data = this.followedLabMetadata!;
    const component = (value: unknown): string => {
      const raw = string(value, operation);
      if (!raw || raw.length > 8192 || /[&#?=\u0000-\u0020\u007f]/.test(raw) || /%(?![0-9a-fA-F]{2})/.test(raw)) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return raw;
    };
    const query = `t=${component(data.timestamp)}&hash=${component(data.hash)}&is_attachment=false`;
    return this.downloadSourcePdf(`${this.path("TestResultsAPI", "v1", "followed/report")}?${query}`, "TestResultsAPI", operation, 2 * 1024 * 1024);
  }

  private async resolveLabTest(selection: LabTestSelection, operation: string): Promise<SourceRecord> {
    if (!selection || !["result", "latest", "followed"].includes(selection.source)) throw new TypeError("lab source must be result, latest or followed");
    const keys = selection.source === "result" ? ["source", "requestId", "docId", "testId"] : ["source", "testId"];
    if (Object.keys(selection).some(key => !keys.includes(key)) || keys.some(key => { const value = (selection as unknown as SourceRecord)[key]; return typeof value !== "string" || !value || value.length > 512; })) throw new TypeError("invalid lab selection");
    const { testId } = selection;
    let rows: SourceRecord[];
    if (selection.source === "result") {
      const {requestId, docId} = selection;
      await this.assertListedTest(requestId, docId, operation);
      await this.getLabResult(requestId, docId);
      const detail = this.labDetails.get(JSON.stringify([requestId, docId]));
      if (!detail) throw new ReadOperationError("OWNER_MISMATCH", operation);
      rows = this.rows(detail.results, operation).flatMap(group => this.rows(group.group_values, operation));
    } else if (selection.source === "latest") {
      await this.listLatestLabResults();
      rows = this.rows(this.latestLabMetadata!.results, operation).flatMap(group => this.rows(group.group_values, operation));
    } else {
      await this.listFollowedLabResults();
      rows = this.rows(this.followedLabMetadata!.followed_tests, operation);
    }
    rows = rows.filter(row => row.test_id === testId);
    if (rows.length !== 1) throw new ReadOperationError("OWNER_MISMATCH", operation);
    return structuredClone(rows[0]!);
  }

  private async readLabComparison(selection: LabTestSelection): Promise<{ raw: SourceRecord; data: LabComparison; date: string }> {
    const operation = "lab-comparison";
    const selected = await this.resolveLabTest(selection, operation);
    const {testId} = selection;
    const date = string(selected.lab_date, operation);
    const query = new URLSearchParams({ test_id: testId, date_of_result: date });
    const path = `/sonline/TestResultsAPI/webapi/mac/v1/compare/${encodeURIComponent(this.owner.memberIdCode)}/${this.owner.memberId}/compare`;
    const raw = object(await json(this.transport, `${path}?${query}`, operation), operation);
    assertRecordOwner(raw, this.owner, operation);
    assertRecordOwner(object(raw.current_result, operation), this.owner, operation);
    this.rows(raw.other_results, operation);
    try { return { raw, date, data: projectLabComparison(raw, testId, date) }; }
    catch (error) {
      if (error instanceof LatestLabResultContentError) throw new ReadOperationError("INVALID_RESPONSE", operation);
      throw error;
    }
  }

  /** Source-selected test history; the comparison date comes from this owner's fresh lab detail. */
  async getLabComparison(selection: LabTestSelection): Promise<ReadResult<LabComparison>> {
    const comparison = await this.readLabComparison(selection);
    return this.result(comparison.data, "TestResultsAPI", "lab-comparison");
  }

  /** Original comparison report in the source-selected list or available graph view. */
  async getLabComparisonPdf(selection: LabTestSelection, view: "list" | "graph" = "list"): Promise<ReadResult<Uint8Array>> {
    const operation = "lab-comparison-pdf";
    if (view !== "list" && view !== "graph") throw new TypeError("view must be list or graph");
    const comparison = await this.readLabComparison(selection);
    const current = comparison.data.current_result;
    if (view === "graph" && ![current, ...comparison.data.other_results].some(row => row.max_lim !== 0 || row.result !== 0)) throw new ReadOperationError("NOT_ELIGIBLE", operation);
    const query = new URLSearchParams({ test_id: selection.testId, t: string(comparison.raw.timestamp, operation), hash: decodeSourceQueryComponent(comparison.raw.hash, operation), date_of_result: comparison.date, is_attachment: "false", is_graph: String(view === "graph"), test_des: current.test_desc, lab_date: current.lab_date });
    const path = `/sonline/TestResultsAPI/webapi/mac/v1/compare/${encodeURIComponent(this.owner.memberIdCode)}/${this.owner.memberId}/compare/report`;
    return this.downloadSourcePdf(`${path}?${query}`, "TestResultsAPI", operation, 2 * 1024 * 1024);
  }

  /**
   * IDs must come from this owner's own observed test summary, never a caller-selected account.
   * Any listed row may be asked for detail; a row the source has no structured detail for fails
   * on the response it returns, which is more honest than guessing from the row's type.
   */
  async getLabResult(requestId: string, docId: string): Promise<ReadResult<LabResult>> {
    const operation = "lab-result";
    const key = JSON.stringify([requestId, docId]);
    if (!this.testReferences.has(key)) await this.listTests();
    if (!this.testReferences.has(key)) throw new ReadOperationError("OWNER_MISMATCH", operation);
    const data = object(await json(this.transport, this.path("TestResultsAPI", "v1", "getresultsbyid"), operation,
      this.post({ request_id: requestId, doc_id: docId, logged_user_gender: this.profile.sex, current_user_gender: this.profile.sex })), operation);
    const groups = this.rows(data.results, operation);
    for (const group of groups) {
      string(group.group_name, operation);
      for (const row of this.rows(group.group_values, operation)) {
        string(row.test_id, operation); string(row.test_desc, operation);
        // Preserve every source value, units, limits, messages and flags; no clinical interpretation.
        if (!("result" in row)) throw new ReadOperationError("INVALID_RESPONSE", operation);
        row.has_result_file = typeof row.result_file === "string" && row.result_file.length > 0;
      }
    }
    string(data.execute_date, operation);
    if (typeof data.is_partial !== "boolean") throw new ReadOperationError("INVALID_RESPONSE", operation);
    this.labDetails.set(key, structuredClone(data));
    const projected = structuredClone(data);
    for (const field of ["result_file", "hash", "time_stamp", "corona_hash", "corona_t"]) delete projected[field];
    for (const group of this.rows(projected.results, operation)) for (const row of this.rows(group.group_values, operation)) {
      for (const field of ["result_file", "hash", "time_stamp"]) delete row[field];
    }
    return this.result(projected as LabResult, "TestResultsAPI", operation);
  }
  async getLabResultFilePdf(selection: LabTestSelection): Promise<ReadResult<Uint8Array>> {
    const operation = "lab-result-file-pdf";
    const row = await this.resolveLabTest(selection, operation);
    if (typeof row.result_file !== "string" || !row.result_file) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    const component = (value: unknown, allowSpaces = false): string => {
      const raw = string(value, operation);
      if (!raw || raw.length > 16384 || /[&#?=\u0000-\u001f\u007f]/.test(raw) || (!allowSpaces && raw.includes(" ")) || /%(?![0-9a-fA-F]{2})/.test(raw)) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return raw;
    };
    let file: string;
    try { file = encodeURIComponent(row.result_file); } catch { throw new ReadOperationError("INVALID_RESPONSE", operation); }
    // Source explicitly encodes the attachment path; the remaining components are interpolated.
    const query = `data=${file}&t=${component(row.time_stamp)}&hash=${component(row.hash)}&testDes=${component(row.test_desc, true)}&labDate=${component(row.lab_date, true)}`;
    return this.downloadSourcePdf(`/sonline/TestResultsAPI/webapi/mac/pdf/showresult?${query}`, "TestResultsAPI", operation, 2 * 1024 * 1024);
  }

  /** Original complete individual laboratory report using fresh owner detail and source print flags. */
  async getLabReportPdf(requestId: string, docId: string, options: LabReportOptions = {}): Promise<ReadResult<Uint8Array>> {
    const operation = "lab-report-pdf";
    if (options.irregularOnly !== undefined && typeof options.irregularOnly !== "boolean") throw new TypeError("irregularOnly must be a boolean");
    await this.assertListedTest(requestId, docId, operation);
    await this.getLabResult(requestId, docId);
    const data = this.labDetails.get(JSON.stringify([requestId, docId]));
    // Ownership is settled by assertListedTest above; this body carries no request_id to match it against.
    if (!data) throw new ReadOperationError("INVALID_RESPONSE", operation);
    for (const field of ["time_stamp", "hash", "execute_date"]) string(data[field], operation);
    const component = (value: unknown): string => {
      const raw = string(value, operation);
      if (!raw || raw.length > 8192 || /[&#?=\u0000-\u0020\u007f]/.test(raw) || /%(?![0-9a-fA-F]{2})/.test(raw)) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return raw;
    };
    const query = `request_id=${component(requestId)}&t=${component(data.time_stamp)}&hash=${component(data.hash)}&irregular_only=${options.irregularOnly ?? false}&is_attachment=false&is_partial=${data.is_partial}&date=${component(data.execute_date)}`;
    return this.downloadSourcePdf(`${this.path("TestResultsAPI", "v1", "getresultsbyid/report")}?${query}`, "TestResultsAPI", operation, 2 * 1024 * 1024);
  }

  /** Existing-profile direct-print branch only; never submits identity details. */
  async getEnglishCovidLabReportPdf(requestId: string, docId: string): Promise<ReadResult<Uint8Array>> {
    const operation = "english-covid-lab-report-pdf";
    if (this.appointmentOwnerData.hasEnglishReportIdentity !== true) throw new ReadOperationError("UNSUPPORTED_FLOW", operation);
    await this.assertListedTest(requestId, docId, operation);
    await this.getLabResult(requestId, docId);
    const data = this.labDetails.get(JSON.stringify([requestId, docId]));
    // Ownership is settled by assertListedTest above; this body carries no request_id to match it against.
    if (!data) throw new ReadOperationError("INVALID_RESPONSE", operation);
    if (data.show_print_corona_english_report !== true) throw new ReadOperationError("NOT_ELIGIBLE", operation);
    for (const field of ["corona_t", "corona_hash"]) string(data[field], operation);
    const component = (value: unknown): string => {
      const raw = string(value, operation);
      if (!raw || raw.length > 8192 || /[&#?=\u0000-\u0020\u007f]/.test(raw) || /%(?![0-9a-fA-F]{2})/.test(raw)) throw new ReadOperationError("INVALID_RESPONSE", operation);
      return raw;
    };
    const query = `data=${component(requestId)}&t=${component(data.corona_t)}&hash=${component(data.corona_hash)}`;
    return this.downloadSourcePdf(`${this.path("TestResultsAPI", "v1", "labs/corona/Report")}?${query}`, "TestResultsAPI", operation, 2 * 1024 * 1024);
  }

  /** Ownership only: the pair must name exactly one row of this owner's freshly listed tests. */
  private async assertListedTest(requestId: string, docId: string, operation: string): Promise<void> {
    const matches = (await this.listTests()).data.tests.filter(row => row.request_id === requestId && row.doc_id === docId);
    // Two rows on one pair is the source contradicting itself, not the caller reaching for someone else's row.
    if (matches.length !== 1) throw new ReadOperationError(matches.length ? "INVALID_RESPONSE" : "OWNER_MISMATCH", operation);
  }
  private rows(value: unknown, operation: string): SourceRecord[] {
    if (!Array.isArray(value)) throw new ReadOperationError("INVALID_RESPONSE", operation);
    return value.map((value) => { const row = object(value, operation); assertRecordOwner(row, this.owner, operation); return row; });
  }
  private path(service: string, version: string, suffix: string): string {
    return `/sonline/${service}/webapi/mac/${version}/members/${encodeURIComponent(this.owner.memberIdCode)}/${this.owner.memberId}/${suffix}`;
  }
  private member() { return { member_id_code: this.owner.memberIdCode, member_id: this.owner.memberId }; }
  private post(body: unknown): RequestInit { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }
  private result<T>(data: T, service: string, operation: string): ReadResult<T> {
    return { data, retrievedAt: new Date().toISOString(), source: { service, operation, completeness: "upstream-response" } };
  }
}
