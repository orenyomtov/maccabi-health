import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { version } from "../../../package.json";
import {
  MaccabiReaders, MaccabiTransport, MaccabiError, ReadOperationError, ReauthenticationRequired, READ_ERROR_GUIDANCE, ISSUES_URL, MaccabiDirectory, isDoctorSpecialtyField, safeClinical,
  type MaccabiSession, type OwnerIdentity, type FetchFunction, type ReadResult, type LabTestSelection,
} from "@maccabi/core";
import { LoginError, login as fileLogin, type LoginHandle } from "@maccabi/cli/login";
import { SessionStoreError } from "@maccabi/cli/store";
import { decodeRef, encodeRef, REF_KINDS, REF_TOKEN, RefTokenError, type DecodedRef } from "./reference";

export interface SessionLease {
  session: MaccabiSession;
  owner: OwnerIdentity;
  save(session: MaccabiSession): Promise<void>;
  invalidate(): Promise<void>;
  reauthentication?: { url?: string; instruction: string };
}
export type SessionResolver = () => Promise<SessionLease | null>;
export type ReaderOperations = Pick<MaccabiReaders,
  "getEnglishCovidLabReportPdf" |
  "listNursingInsuranceReports" | "getNursingInsuranceReportPdf" | "getAdministrativeRequest" | "getAdministrativeRequestPdf" | "listPrescriptionAlternatives" |
  "getLabReportPdf" |
  "listFollowedLabResults" | "getFollowedLabResultsPdf" |
  "listLatestLabResults" | "getLatestLabResultsPdf" | "getLabComparison" | "getLabComparisonPdf" |
  "getVisitDocumentPdf" | "getFutureAppointment" |
  "getQuarterlyBillingReportPdf" | "getInquiryDocumentPdf" | "getVisitSummaryPdf" | "listQuarterlyBillingReports" | "renewSession" | "getLabResultFilePdf" | "getPrescriptionPdf" | "getNotificationPdf" | "getSensitivityPdf" | "getAdditionalInformationPdf" | "getOwnerContactProfile" | "getNotificationPreferences" | "listAccountAccess" | "listNotifications" | "getMedicalRecommendations" | "getSelectedMedicalSummary" | "listHospitalHistory" | "getHospitalReportPdf" | "getOwnerProfile" | "listPrescriptions" | "listReferrals" | "listTests" | "getLabResult" | "listVisits" | "getVisit" |
  "getReferralPdf" | "listFutureAppointments" | "getAscribedProvider" | "listRecentProviders" | "getAppointmentProvider" |
  "checkAppointmentEligibility" | "getClinicAvailability" | "listVaccinationGroups" | "getVaccinationDoses" | "listSensitivities" | "getVaccinationCertificatePdf" | "listInquiries" | "getInquiry" | "getEnglishMedicalSummaryPdf" | "listAdministrativeRequests" | "getMedicationReportPdf" | "getPaymentMethods" | "getOutstandingDebt" | "listCertificates" | "getCertificatePdf" | "getImagingResultPdf" | "listAdditionalInformation" |
  "listImagingStudies" | "getImagingStudy" | "getImagingImage">;
export interface ConnectedReaders { readers: ReaderOperations; exportSession(): Promise<MaccabiSession> }
export interface MaccabiMcpOptions {
  resolveSession: SessionResolver;
  createDirectory?: () => Pick<MaccabiDirectory, "listProviderFields" | "listProviderCities" | "searchProviders" | "getProviderDetails">;
  connect?: (session: MaccabiSession, owner: OwnerIdentity) => Promise<ConnectedReaders>;
  fetch?: FetchFunction;
  /** HTTP deployments share this per-owner executor across request-scoped server instances. */
  runExclusive?: Executor;
  /** How long one call may hold the session before it is abandoned. Tests use a short one. */
  operationTimeoutMs?: number;
  reauthentication?: { url?: string; instruction: string };
  /** Sign-in is local-state work, so it is injected separately from the owner-scoped readers. */
  login?: LoginHandle;
  /**
   * `status-only` drops maccabi_login_start and maccabi_login_verify. HTTP deployments sign in through
   * the browser, so keeping those two would put the member ID and the SMS code into model context for
   * no reason. stdio keeps them: there is no browser leg there.
   */
  loginTools?: "all" | "status-only";
}
const JSON_LIMIT = 128 * 1024;
const PDF_LIMIT = 2 * 1024 * 1024;
const PAGE_BUDGET = 96 * 1024;
export const COVERAGE_URI = "maccabi://service/coverage";
export const COVERAGE = {
  scope: "Supported own-account reads, anonymous public provider-directory reads, and explicit one-shot session renewal. No booking, cancellation, prescription renewal or read-state writes. Clinic availability starts a scheduling conversation; session renewal changes expiry state.",
  directory: "Anonymous category-based field/city discovery, search/page selection and provider detail for doctors or labs-and-therapists. No account session. Browser search/page/detail responses observed; library live access remains unverified/challenge-blocked. Details re-run the returned selection context to bind private routing. No booking links, retries or bypass.",
  session: "maccabi_renew_session renews the active owner session once, saves updated cookies, and stops on any error or reauthentication. It changes session expiry state; no continued-authentication guarantee, automatic SMS or background renewal. It cannot reset an open browser document's idle/logout countdown; sustained session preservation remains unproven.",
  records: "Prescriptions and prescription PDFs, purchased-medication report PDF, referrals and referral PDFs, medical-certificate lists/PDFs in explicit date ranges, laboratory summaries/results and owner-listed imaging-result PDFs, visit history/details and source-backed summary PDFs, appointments, vaccination groups/certificate PDF, doctor-request lists/details, associated-visit referral PDFs and supported source-backed approval PDFs, an English medical-summary PDF, and projected sensitivity/administrative-request timelines.",
  laboratory: "Latest-result groups, followed-test/counter/options envelope, original latest/followed reports and whole individual lab-report PDF. Comparison JSON/list-mode PDF and row attachment PDFs accept source=result/latest/followed with a unique test ID; only result takes request/doc IDs. Fresh owner data derives dates and routing. Latest and result-view comparison browser responses were observed; new getters and followed/whole-report branches are tested offline. No follow/unfollow writes or complete-history claim.",
  settings: "Persisted notification groups, services and channels with current registration/restriction state, plus account-access viewer state and displayed authorized users. Current account-access observation was creation-available, not an empty successful viewer list; populated users are source-backed/offline tested. No preferences save, family application, grant, extension or revocation.",
  personal: "Owner contact fields and notifications in an explicit range: type-1 letters, type-2 status/has_document, and type-3 tutorials. Type-1/type-2 reference and type-3 tutorials[].pdf_reference select PDFs using the same range. Type-2 status-1 references use the runtime feature selector and bounded polling; eligible live PDF retrieval remains unverified. Types 2/3 are source-backed/offline tested. Validated webpage/video links are returned but never fetched. No dependent letters, mark-read or profile updates.",
  legacy: "Observed single-section recommendation text/table, selected medication/laboratory summary text/tables, and hospital/ER rows using an explicit as-of date and the source page lookback (three years in captured settings). Owner-listed hospital report PDFs use a local path/type-derived reference and the same as-of date. Additional layouts remain unsupported; these are not a complete medical history.",
  billing: "Observed payment-authorization summary with full account numbers omitted, plus fixed other-payer-branch totals labeled source.scope=payer-account-aggregate. Individual debtor and currency attribution are unavailable; no payment or authorization changes.",
  nursingInsurance: "Annual report catalog and original PDF visible in the owner billing page, with local references and initial-page counts. Browser catalog/PDF observed; getters tested offline. No individual insured-person attribution, enrollment/payment action or complete-history claim.",
  administrative: "Case/ServiceRequest correspondence, supported obligation/decision fields and eligible attachment/decision-print PDFs retain coverage=common and unsupported_sections. Populated data is source-backed/offline tested; the live list was empty. Nullable attachment titles remain null. No approval, payment, submission or mark-read write.",
  billingReports: "Quarterly report catalog returns available periods, selected period, fixed view-action labels/production dates and upstream reported counts (cross-page result-count meaning unverified). Optional period must match a fresh owner-page option; default follows that page. Initial catalog page only, not itemized charges. Each report row carries a ref for maccabi_document, which returns that quarter's original PDF; the ref already holds the row's local reference and the selectedPeriod.value it was listed under, so neither is passed separately.",
  additionalInformation: "Required explicit date range; only an empty account response was captured. Display-field projection comes from official frontend source and retains source.schemaEvidence. Type-1 PDFs have local references for source-backed downloads using the same range; populated rows/PDFs remain unvalidated live. Video/link downloads are unsupported; raw URLs are never returned.",
  sourceBackedPdfs: "Individual prescription, type-1 additional-information, per-lab-row attached-result, supported inquiry-approval and nested visit-document PDF readers follow official source with synthetic tests; these getter responses have not been validated live. Visit-summary, inquiry-associated referral and quarterly-report PDFs have captured UI responses; their implemented getters are tested offline and have not been called live. Sensitivity-report and type-1 notification PDF bytes were verified in owner-session reads. Additional-information list capture was empty.",
  appointments: "Future appointments and eligible normal-provider detail/contact/instruction reads use fixed official-frontend projections, retaining source.schemaEvidence; the account capture was empty, so populated rows/details are offline-tested only. Also supports recent providers, clinic details, eligibility and first clinic availability. No subsidiary detail, instruction-link fetch, date/time selection or booking submission.",
  limits: ["Inquiry detail supports source-expandable non-automatic inquiries; automatic_sick_permit exposes its document reference directly in the list. Unobserved nested payloads and unsupported attachment branches remain unavailable; supported remarks and request arrays are preserved with unsupported_sections for excluded edit-only fields. Inquiry document PDFs support eligible no-associated-visit forms 1-5 and source-eligible associated visit documents/summary through current detail references. A captured associated referral PDF does not validate all other form branches; their live evidence remains distinct. Administrative reimbursement/approval requests are separate.", "Sensitivity and administrative timelines use fixed official-frontend field projections; this account returned empty collections. Their source.schemaEvidence labels retain that limit. An empty sensitivity list does not establish absence of allergies.", "Vaccination group summaries and per-group dose rows are separate reads. Dose schemas come from official frontend fields and retain source.schemaEvidence; one populated owner-group response was verified live; other groups and complete history remain unverified. Neither is a complete immunization record.", "Upstream retention and complete historical paging are unverified.", "List offsets paginate a newly fetched local response; data can change between calls.", "Laboratory year filtering uses the original execution year locally, not upstream paging.", "Public directory supports doctors and labs/institutes/therapists, one field, optional city/name, pages and fixed detail display. Treatment/multi-field filters, full price/team relationships, other categories and booking links remain unavailable. Unobserved legacy medical sections are not implemented."],
  imaging: "Imaging studies are listed from the test rows, and their series, images and per-image DICOM metadata are read from the external MedDream viewer Maccabi hands them off to. The study UID must be the request_id of one imaging_study row on a fresh owner list, and series/image UIDs must appear in that study's own structure; nothing in the capture says whether the viewer itself refuses a study it did not hand out, so this client does the constraining. Image bytes are deliberately not available here: the preview JPEG and the raw headerless pixel buffer are megabyte-scale binaries a model cannot use, and the local CLI writes them to a file instead (`maccabi imaging-thumbnail` / `maccabi imaging-pixels`, which also prints the geometry the buffer needs). All of it was built from one captured ultrasound session and has since been run live against that viewer end to end; only 8-bit ultrasound is evidenced, single-frame, in 1-sample and 3-sample form, no viewer error response was ever captured, so the status-code mappings remain assumptions, and token lifetimes are unmeasured. Viewer payloads name the patient, so they go through the same omit filter as every other read. No mark-read write.",
  privacy: "Known unnecessary identity fields and upstream credential/document-signature fields are excluded from structured clinical results; original clinical prose is preserved and is not guaranteed to be de-identified. PDFs are private original documents and may contain identity details printed by Maccabi.",
  output: { defaultPageSize: 20, maximumPageSize: 50, maximumJsonBytes: JSON_LIMIT, maximumPdfBytes: PDF_LIMIT },
};
class OutputLimit extends Error {}
/** A ref was well-formed but does not select what the tool was asked for. Not an upstream failure. */
class SelectionError extends Error {}

/**
 * One suggested follow-up call, with its arguments already taken from the result it is attached to.
 *
 * This is the part of a result a caller acts on rather than reads: it names the tool, hands over the
 * exact arguments, and says in one line what comes back. Where a step applies to every row, the
 * arguments are filled from the first one and `why` says so, so the call is runnable as printed and
 * still generalises. The list stays short on purpose - the useful moves, not every legal call.
 */
export interface NextStep { tool: string; arguments: Record<string, unknown>; why: string }
function withNext<T extends object>(value: T, next: NextStep[]): T {
  return next.length === 0 ? value : { ...value, next };
}
/** A row only gets a token when it actually carries the identifiers that token would have to hold. */
function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}
function firstRef(paged: { data: { ref?: string }[] }): string | undefined {
  return paged.data.find(row => row.ref !== undefined)?.ref;
}
function documentStep(paged: { data: { ref?: string }[] }, why: string): NextStep[] {
  const ref = firstRef(paged);
  return ref === undefined ? [] : [{ tool: "maccabi_document", arguments: { ref }, why: `${why} Each row carries its own ref.` }];
}
/**
 * The first reference buried anywhere in a detail payload, so a result can point at a document it
 * carries without this file having to know that visit attachments live under drugs/referrals/
 * approvals/tutorials and inquiry attachments do not.
 */
function findReference(value: unknown, keys: readonly string[], depth = 8): string | undefined {
  if (depth < 0 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findReference(item, keys, depth - 1); if (found) return found; }
    return undefined;
  }
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate)) return candidate;
  }
  for (const item of Object.values(value)) { const found = findReference(item, keys, depth - 1); if (found) return found; }
  return undefined;
}
function output(value: unknown): CallToolResult {
  const safe = safeClinical(value) as Record<string, unknown>;
  const text = JSON.stringify(safe);
  if (Buffer.byteLength(text) > JSON_LIMIT) throw new OutputLimit();
  return { content: [{ type: "text", text }], structuredContent: safe };
}
function documentResult(pdf: ReadResult<Uint8Array>): CallToolResult {
  if (pdf.data.byteLength > PDF_LIMIT) throw new OutputLimit();
  const metadata = output({ retrievedAt: pdf.retrievedAt, source: pdf.source, mimeType: "application/pdf", bytes: pdf.data.byteLength, containsOriginalDocument: true });
  return { ...metadata, content: [...metadata.content, { type: "resource", resource: { uri: `maccabi://document/${crypto.randomUUID()}`, mimeType: "application/pdf", blob: Buffer.from(pdf.data).toString("base64") } }] };
}
function errorResult(code: string, instruction: string, url?: string, next?: NextStep[]): CallToolResult {
  const result = { error: { code, instruction, ...(url ? { reauthenticationUrl: url } : {}), ...(next?.length ? { next } : {}) } };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
}
/** A ref that will not decode is a caller mistake with one fix, so the error says which one. */
function referenceError(error: unknown): CallToolResult {
  if (!(error instanceof RefTokenError)) throw error;
  return errorResult("INVALID_REFERENCE", `${error.message} A ref is copied from a list result exactly as it appears; it is never edited, shortened or built by hand.`, undefined,
    [{ tool: "maccabi_capabilities", arguments: {}, why: "Which list tool produces the row you want, and what its ref then reaches." }]);
}
/** Runs work to completion before the next piece of work starts. */
export type Executor = <T>(work: () => Promise<T>) => Promise<T>;
/**
 * How long one piece of work may hold the shared session before it is abandoned. A healthy call is a
 * second or two, and the transport caps each request it makes at thirty, so this is a backstop for
 * stalls that escape that cap rather than a budget any real read spends.
 *
 * It sits above the worst case of the pending-mailing poll - six requests that could each burn the
 * full transport timeout, plus five five-second waits, about 205s - on purpose. A backstop that can
 * kill a documented legitimate path is a second bug wearing the costume of a fix, and the per-request
 * thirty-second cap is what actually ends a hang. This only has to guarantee the queue moves again.
 */
export const OPERATION_TIMEOUT_MS = 240_000;
/** One unit of work on the shared session outlived its bound and was abandoned, not cancelled. */
export class OperationTimeout extends Error {}
/**
 * Bounds one task. The work cannot actually be cancelled - an abandoned fetch keeps running - but the
 * promise the executor awaits settles either way, which is the whole point: the mutex is released and
 * the next call is answered instead of queueing behind a stall with no end.
 */
function bounded<T>(work: () => Promise<T>, timeoutMs: number): () => Promise<T> {
  return () => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new OperationTimeout()); }, timeoutMs);
    timer.unref?.(); // A bound on work already in flight is never a reason to hold the process open.
    work().then(resolve, reject).finally(() => { clearTimeout(timer); });
  });
}
/**
 * One session, one thing at a time - and never for ever. Tool calls, sign-in and the background
 * renewal timer all queue on the same executor, so an unbounded wait anywhere in it used to block
 * every later tool call with no recourse: an MCP client cannot cancel a server that simply never
 * answers. Each task therefore carries its own deadline, and a task that overruns is dropped from the
 * queue so the work behind it runs.
 */
export function serialExecutor(timeoutMs: number = OPERATION_TIMEOUT_MS): Executor {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = bounded(work, timeoutMs);
    const task = tail.then(run, run);
    tail = task.catch(() => undefined);
    return task;
  };
}
const pageShape = { offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(50).default(20) };
const id = z.string().min(1).max(512);
const localReference = z.string().regex(/^[a-f0-9]{64}$/, "Use the lowercase 64-character reference shown inside the row this ref came from");
/** Interpolated into a viewer URL path, so the shape is a schema rule rather than a later check. */
const dicomUid = z.string().min(1).max(64).regex(/^\d+(?:\.\d+)*$/, "Use a DICOM UID exactly as the imaging study returned it");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine(value => {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, "Use a valid calendar date");
interface PageInfo { offset: number; returned: number; totalInUpstreamResponse: number; nextOffset: number | null; truncated: boolean; strategy: string; completeHistory: boolean }
type Paged<T> = Omit<ReadResult<T[]>, "data"> & { data: (T & { ref?: string })[]; page: PageInfo };
/**
 * Slices a fetched response locally and mints each returned row's `ref` as it goes, so the token is
 * inside the budget check rather than pushing the page over it afterwards.
 */
function page<T extends object>(result: ReadResult<T[]>, args: { offset: number; limit: number }, refOf?: (row: T) => string | undefined): Paged<T> {
  const rows = result.data;
  const items: (T & { ref?: string })[] = [];
  for (const row of rows.slice(args.offset, args.offset + args.limit)) {
    const ref = refOf?.(row);
    const item = ref === undefined ? row : { ...row, ref };
    if (Buffer.byteLength(JSON.stringify(safeClinical([...items, item]))) > PAGE_BUDGET) {
      if (items.length === 0) throw new OutputLimit();
      break;
    }
    items.push(item);
  }
  const nextOffset = args.offset + items.length < rows.length ? args.offset + items.length : null;
  return { ...result, data: items, page: { offset: args.offset, returned: items.length, totalInUpstreamResponse: rows.length, nextOffset, truncated: nextOffset !== null, strategy: "local-response-offset", completeHistory: false } };
}
/** The "there is more of this response" step, which is the one follow-up a caller most often misses. */
function nextPage(tool: string, args: Record<string, unknown>, paged: { page: PageInfo }, limit: number): NextStep[] {
  if (paged.page.nextOffset === null) return [];
  return [{ tool, arguments: { ...args, offset: paged.page.nextOffset, limit }, why: "The rest of this same fetched response. Follow page.nextOffset until it is null; reaching the end is not complete history." }];
}

/** The default owner binding: one transport per use, so its refreshed cookies can be exported and saved. */
export async function connectSession(session: MaccabiSession, owner: OwnerIdentity, fetch?: FetchFunction): Promise<ConnectedReaders> {
  const transport = new MaccabiTransport({ session, fetch });
  return { readers: await MaccabiReaders.create(transport, owner), exportSession: () => transport.exportSession() };
}

/**
 * The reader here is a model, and a model cannot open an issue. So the ask is not "report this" but
 * "hand the member the link", which is the only form of it that can end in an actual report.
 */
const DEFECT_GUIDANCE = `Gaps and defects: a tool that fails with INVALID_RESPONSE or UNSUPPORTED_FLOW, or in a way this server does not explain, is a gap in this client rather than a member mistake. The same goes for a read that is missing, incomplete or plainly wrong. You cannot open an issue yourself, so give the member ${ISSUES_URL} together with the tool name and what was asked. Report a security problem privately instead, as SECURITY.md describes, and never quote clinical data into either.`;

/**
 * The journeys worth knowing before planning a sequence of calls, each as the ordered tool calls
 * that get from an empty conversation to the thing asked for. maccabi_capabilities returns these,
 * and the relevant step also arrives in `next` on the result that makes it possible - so a caller
 * that reads results never has to come back here, and a caller planning ahead never has to guess.
 */
export const FLOWS = [
  { goal: "A laboratory result, and its original report as a PDF", steps: [
    { tool: "maccabi_tests", note: "Newest first. Laboratory rows are the ones with laboratory detail; `year` filters execution dates locally." },
    { tool: "maccabi_detail", note: "Pass the row's `ref`. Returns the values, units, reference ranges and partial-result flags." },
    { tool: "maccabi_document", note: "Same `ref`, variant=laboratory_report for the whole report, or no variant for whatever document the row attaches." },
  ] },
  { goal: "The history of one analyte, further back than the summary list reaches", steps: [
    { tool: "maccabi_latest_labs", note: "Find the analyte in a group and take its group_values[].test_id. The result's own `ref` identifies the latest-results view." },
    { tool: "maccabi_detail", note: "That `ref` plus `test_id`. Returns current and historical values with graph eligibility." },
    { tool: "maccabi_document", note: "Same pair with variant=comparison_graph or comparison_list for the source's own comparison PDF." },
  ] },
  { goal: "An imaging study's series, images and pixel data", steps: [
    { tool: "maccabi_imaging_studies", note: "Imaging rows have no attached document; their scans live in the external viewer." },
    { tool: "maccabi_detail", note: "The row's `ref`. Returns study date, modality and the series/instances tree." },
    { tool: "maccabi_detail", note: "Same `ref` plus a series_instance_uid and sop_instance_uid from that tree, for one image's DICOM metadata." },
    { tool: "maccabi imaging-thumbnail / maccabi imaging-pixels", note: "Not MCP tools. The preview JPEG and the raw pixel buffer are megabyte-scale binaries, so the CLI writes them to a file in the member's own terminal instead." },
  ] },
  { goal: "Upcoming appointments, and where to go for one", steps: [
    { tool: "maccabi_upcoming_appointments", note: "Future only. Past visits are maccabi_past_visits." },
    { tool: "maccabi_detail", note: "The row's `ref`. Returns the provider's contacts and the visit instructions; instruction links are returned, never fetched." },
  ] },
  { goal: "A past visit and the documents from it", steps: [
    { tool: "maccabi_past_visits", note: "Each row carries a `ref`." },
    { tool: "maccabi_detail", note: "Reads the visit and exposes a pdf_reference for each eligible attached document." },
    { tool: "maccabi_document", note: "The visit's `ref` alone for its summary PDF, or with `reference` set to one of those pdf_reference values for an attachment." },
  ] },
  { goal: "A prescription's PDF, and what else the pharmacy lists for it", steps: [
    { tool: "maccabi_prescriptions", note: "`status` and `permanent` filter the same fetched response locally." },
    { tool: "maccabi_document", note: "The row's `ref`, for a digital prescription with purchase status 1, 2 or 3." },
    { tool: "maccabi_detail", note: "Same `ref`, for the alternatives the source lists. Not a recommendation to change treatment." },
  ] },
  { goal: "Anything filed under a date range: certificates, letters, hospital admissions", steps: [
    { tool: "maccabi_medical_certificates / maccabi_mailings / maccabi_hospital_visits", note: "Each needs its dates up front. The row's `ref` carries those dates, so the download never has to be given them again." },
    { tool: "maccabi_document", note: "The row's `ref`. A type-3 mailing also needs `reference` set to one of its tutorials[].pdf_reference values." },
  ] },
  { goal: "A public provider, with no account at all", steps: [
    { tool: "maccabi_directory_specialties", note: "Category `doctors`, or `labs-and-therapists` for labs, institutes and therapists. Returns the field keys a search takes." },
    { tool: "maccabi_directory_search", note: "Category and field key, optionally a city key from maccabi_directory_cities, a name, or a page." },
    { tool: "maccabi_detail", note: "A provider row's `ref`, which carries the search context the detail read needs." },
  ] },
] as const;

/** One owner-bound factory for local stdio and loopback HTTP. No credential tool arguments. */
export function createMaccabiMcpServer(options: MaccabiMcpOptions): McpServer {
  const browserLogin = options.loginTools === "status-only";
  const signInSteps: NextStep[] = browserLogin
    ? [{ tool: "maccabi_login_status", arguments: {}, why: "Confirm whether anything is signed in. The sign-in itself runs in the member's own browser through this server's authorization page; retry the read and let the client re-run authorization." }]
    : [{ tool: "maccabi_login_status", arguments: {}, why: "Confirm whether a session is saved or a challenge is still open, before spending an SMS." },
       { tool: "maccabi_login_start", arguments: {}, why: "Only if the member cannot run `maccabi login` in their own terminal: it needs their ID number and puts it, and the SMS code, into this conversation. One SMS per call, one code attempt." }];
  const signInGuidance = browserLogin
    ? "Signing in: maccabi_login_status reports whether this member has a saved session. The sign-in itself happens in the member's own browser, through the authorization page this server serves, so no ID number or SMS code passes through this conversation. If a read reports REAUTHENTICATION_REQUIRED, retry and let the MCP client re-run authorization."
    : "Signing in: maccabi_login_status reports local state, maccabi_login_start sends one SMS code and maccabi_login_verify completes the sign-in. Those two carry the ID number and the SMS code through this conversation and into model context, so prefer `maccabi login` in the member's own terminal whenever that is possible. One code per SMS: a wrong code ends the challenge instead of being retried, because retries lock the Maccabi account.";
  const server = new McpServer({ name: "maccabi-health", version }, { instructions: "Private health information for the authenticated owner. Preserve source Hebrew, values, units, reference ranges and dates. How this server is meant to be used: maccabi_capabilities describes everything it can read and the worked journeys through it; a list tool returns rows; every row carries an opaque `ref`; maccabi_detail reads the record behind a ref and maccabi_document returns its original PDF. You never assemble a pair of identifiers yourself, and you rarely need to guess a tool, because every result carries a `next` list of the calls that sensibly follow it with their arguments already filled in. Follow page.nextOffset to consume the available response; reaching its end does not establish complete historical coverage. Year filters do not fetch older upstream pages. Distinguish explicit portal links from associations inferred using dates, notes or referral text. Label inferred associations clearly, and do not present an inferred diagnosis as documented fact. PDFs contain original bytes, not extracted text. Do not interpret missing or filtered history as a negative clinical finding. Booking and other care changes are unavailable. Read maccabi://service/coverage for coverage limits. " + signInGuidance + " " + DEFECT_GUIDANCE });
  const operationTimeoutMs = options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
  const exclusive = options.runExclusive ?? serialExecutor(operationTimeoutMs);
  const connect = options.connect ?? ((session, owner) => connectSession(session, owner, options.fetch));
  /** What a caller is told when its own call was the one abandoned, rather than left waiting for ever. */
  function timedOut(): CallToolResult {
    return errorResult("REQUEST_TIMEOUT", `This call did not finish within ${Math.round(operationTimeoutMs / 1000)} seconds and was abandoned, so the server keeps answering instead of blocking every later call behind it. Nothing was saved, and no login or SMS was attempted. Retry once; if it repeats, the portal or the network is stalling rather than the arguments being wrong.`);
  }
  async function withOwner(work: (readers: ReaderOperations) => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
      return await exclusive(async () => {
      // Started here rather than at the call, because the executor's own deadline starts when the
      // task reaches the front of the queue. Timing it from the call would make a read that merely
      // waited its turn look abandoned and silently drop a save it was entitled to make.
      const abandonedAt = Date.now() + operationTimeoutMs;
      let lease: SessionLease | null = null;
      try {
        lease = await options.resolveSession();
        if (!lease) {
          const guidance = options.reauthentication ?? { instruction: "Run the local Maccabi CLI login, then retry. maccabi_login_start and maccabi_login_verify can sign in from here instead, at the cost of putting the ID number and the SMS code into this conversation." };
          return errorResult("REAUTHENTICATION_REQUIRED", guidance.instruction, guidance.url, signInSteps);
        }
        const connected = await connect(lease.session, lease.owner);
        const result = await work(connected.readers);
        // An overrun call has already been answered with a timeout and no longer owns the session.
        // Saving from here would drop its older cookie jar over whatever ran after it, which can cost
        // the member the SMS that replaces a rotated session cookie.
        if (Date.now() < abandonedAt) await lease.save(await connected.exportSession());
        return result;
      } catch (error) {
        // The ref decoded but does not select what this tool was asked for. It is a caller mistake
        // with a named fix, so it stays out of the upstream-failure ladder below.
        if (error instanceof SelectionError) return errorResult("INVALID_SELECTION", error.message, undefined, [{ tool: "maccabi_capabilities", arguments: {}, why: "Which rows carry which reads, and the worked journeys through them." }]);
        if (error instanceof RefTokenError) return referenceError(error);
        // Only a real reauthentication invalidates the lease; over HTTP that also revokes the member's
        // OAuth grant, which is far too expensive for a live session that is merely viewing a dependent.
        if (error instanceof ReauthenticationRequired) {
          try { await lease?.invalidate(); } catch { return errorResult("SESSION_INVALIDATION_FAILED", "The expired session could not be removed from protected storage. Repair session storage before retrying."); }
          const guidance = lease?.reauthentication ?? options.reauthentication ?? { instruction: "Run the local Maccabi CLI login, then retry. maccabi_login_start and maccabi_login_verify can sign in from here instead, at the cost of putting the ID number and the SMS code into this conversation." };
          return errorResult("REAUTHENTICATION_REQUIRED", guidance.instruction, guidance.url, signInSteps);
        }
        if (error instanceof OutputLimit) return errorResult("RESULT_TOO_LARGE", "Request fewer list records, or use the local CLI for a large structured result. Some core PDF readers also enforce the document limit. No result was silently shortened.");
        if (error instanceof ReadOperationError) return errorResult(error.code, READ_ERROR_GUIDANCE[error.code](error.operation));
        // Local storage failed, not Maccabi: say so, so a broken config directory is not mistaken for upstream flakiness. Its message can name a path, so it stays out of the result.
        if (error instanceof SessionStoreError) return errorResult(error.code, "Protected session storage could not be read or written. Check the permissions of the maccabi config directory, then retry. No credentials or file path are included in this error.");
        if (error instanceof MaccabiError) return errorResult(error.code, "The upstream request could not be completed. No automatic login or SMS was attempted.");
        // Nothing above matched, so this is the branch that means the failure was never anticipated.
        return errorResult("READ_UNAVAILABLE", `The read or protected session storage is unavailable. No credentials or upstream response were included in this error. This failure was not anticipated by this client: give the member ${ISSUES_URL} so it can be reported.`);
      }
      });
    } catch (error) {
      // The deadline fires outside the work, so it is the one failure the ladder above cannot see.
      if (error instanceof OperationTimeout) return timedOut();
      throw error;
    }
  }
  function register<T extends z.ZodRawShape>(name: string, description: string, schema: z.ZodObject<T>, action: (readers: ReaderOperations, args: z.output<z.ZodObject<T>>) => Promise<unknown>, idempotent = true, readOnly = true): void {
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: true } },
      args => withOwner(async readers => output(await action(readers, args))));
  }
  async function withDirectory(action: (directory: Pick<MaccabiDirectory, "listProviderFields" | "listProviderCities" | "searchProviders" | "getProviderDetails">) => Promise<unknown>): Promise<CallToolResult> {
    try { return output(await action(options.createDirectory?.() ?? new MaccabiDirectory({ fetch: options.fetch }))); }
    catch (error) {
      if (error instanceof OutputLimit) return errorResult("RESULT_TOO_LARGE", "Use the local CLI for this public directory result; no result was silently shortened.");
      if (error instanceof MaccabiError && error.code === "DIRECTORY_CONFIGURATION_UNAVAILABLE") return errorResult(error.code, "The public directory host served a bot-challenge page instead of the site. This affects all public-directory reads, is scored per request rather than fixed, and is not something this client can reliably get past. Use the official directory in a browser; no search was submitted and no account session was involved.");
      return errorResult(error instanceof MaccabiError ? error.code : "DIRECTORY_REQUEST_FAILED", "Public directory request failed. The usual cause is the host's bot challenge, which answers programmatic clients with a challenge page and cannot be reliably got past; otherwise use a current field from maccabi_directory_specialties for this category and check connectivity. No account session was used.");
    }
  }
  /** The one call that replaces reading 38 tool names and guessing how they fit together. */
  function capabilities(): unknown {
    return {
      server: { name: "maccabi-health", version, transport: browserLogin ? "http" : "stdio" },
      howItWorks: [
        "A list tool returns rows. Every row carries an opaque `ref`.",
        "maccabi_detail reads the record behind a ref; maccabi_document returns that row's original PDF. Between them they cover every row-scoped read, so there is no third tool to find.",
        "A ref already holds everything the follow-up needs - a request id and its document id, a reference and the date range it was listed in, a report reference and its period - so two rows' identifiers can never be crossed. The raw identifiers stay in the row; they are for reading and correlating, not for reassembling.",
        "Two optional selectors pick something inside a row, and both are copied verbatim from a payload you already have: `test_id` for one analyte, `reference` for one listed attachment.",
        "maccabi_report returns the account-wide PDFs that belong to no row.",
        "Every result carries a `next` list: the calls that sensibly follow it, with their arguments already filled in from that result. Follow it instead of guessing.",
      ],
      flows: FLOWS,
      rowKinds: REF_KINDS,
      signIn: signInGuidance,
      writes: "None. This server reads. maccabi_renew_session changes session expiry and maccabi_clinic_availability opens a scheduling conversation and stops; nothing books, cancels, pays, renews a prescription or marks anything read.",
      coverage: COVERAGE,
      problems: DEFECT_GUIDANCE,
    };
  }
  const directoryCategory = z.enum(["doctors", "labs-and-therapists"]);
  const directorySearchSchema = z.object({
    category: directoryCategory,
    field: z.string().refine(isDoctorSpecialtyField, "Use a field key from maccabi_directory_specialties for this category"),
    city: z.string().refine(isDoctorSpecialtyField, "Use a city key from maccabi_directory_cities for this category").optional(),
    name: z.string().max(200).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value), "Use a nonempty provider name without control characters").optional(),
    page: z.number().int().min(1).max(1000).optional(),
  }).strict();
  const directoryOptions = (a: z.infer<typeof directorySearchSchema>) => ({ ...(a.city === undefined ? {} : { city: a.city }), ...(a.name === undefined ? {} : { name: a.name }), ...(a.page === undefined ? {} : { page: a.page }) });
  const publicTool = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool("maccabi_capabilities", {
    description: "Start here. Describes what this server can read, the worked journeys from an empty conversation to a result, how row references and the `next` list work, and where coverage stops. Needs no account and makes no upstream request. Read it once before planning a sequence of calls; individual tool results then carry their own `next` steps.",
    inputSchema: z.object({}).strict(), annotations: publicTool,
  }, async () => output(capabilities()));

  server.registerTool("maccabi_directory_specialties", {
    description: "List the specialties and services the public provider directory can be searched by. Takes a category: `doctors`, or `labs-and-therapists` for labs, institutes and therapists. Returns `field` keys and their Hebrew labels; a search in the same category takes one of those keys. Public catalog: no account, session or cookies.",
    inputSchema: z.object({ category: directoryCategory }).strict(), annotations: publicTool,
  }, a => withDirectory(async r => {
    const result = await r.listProviderFields(a.category);
    const first = result.data[0];
    return { ...result, ...(first ? { next: [{ tool: "maccabi_directory_search", arguments: { category: a.category, field: first.field }, why: "Search this category with any data[].field key. Add city or name to narrow it." }] } : {}) };
  }));
  server.registerTool("maccabi_directory_cities", {
    description: "List the city keys the public provider directory accepts for a category, with their Hebrew labels. A search takes one of these keys as its optional `city`. Public catalog: no account access.",
    inputSchema: z.object({ category: directoryCategory }).strict(), annotations: publicTool,
  }, a => withDirectory(r => r.listProviderCities(a.category)));
  server.registerTool("maccabi_directory_search", {
    description: "Search the public provider directory. Needs a category and a `field` key from maccabi_directory_specialties; optional `city` key, provider `name` and upstream `page`. Returns matching providers with names, addresses and phone numbers, each row carrying a `ref` for maccabi_detail. Page bounds are checked against a freshly fetched catalog. No account cookies, no booking links, no retries.",
    inputSchema: directorySearchSchema, annotations: publicTool,
  }, a => withDirectory(async r => {
    const result = await r.searchProviders(a.category, a.field, directoryOptions(a));
    const selection = result.data.selection;
    const providers = result.data.providers.map(provider => ({ ...provider, ref: encodeRef("directory_provider", { category: selection.category, field: selection.field, reference: provider.reference, ...selection.options }) }));
    const first = providers[0];
    return { ...result, data: { ...result.data, providers },
      ...(first ? { next: [{ tool: "maccabi_detail", arguments: { ref: first.ref }, why: "Contacts, hours, services and source remarks for one provider. Each row carries its own ref." }] } : {}) };
  }));
  const loginHandle = options.login ?? fileLogin();
  /** Sign-in never reaches withOwner: there is no owner yet, and no upstream error text or argument may reach the model. */
  async function withLogin(work: (handle: LoginHandle) => Promise<unknown>): Promise<CallToolResult> {
    try {
      return await exclusive(async () => {
        try { return output(await work(loginHandle)); }
        catch (error) {
          if (error instanceof LoginError) return errorResult(error.code, error.message);
          if (error instanceof SessionStoreError) return errorResult(error.code, "Protected login storage could not be read or written. Check the permissions of the maccabi config directory, then retry. No ID number, SMS code or file path is included in this error.");
          if (error instanceof MaccabiError) return errorResult(error.code, "The sign-in step did not complete. Start again with maccabi_login_start; no code was resent and nothing was retried.");
          return errorResult("LOGIN_UNAVAILABLE", "Protected login storage is unavailable. No ID number, SMS code or upstream response is included in this error.");
        }
      });
    } catch (error) {
      if (error instanceof OperationTimeout) return timedOut();
      throw error;
    }
  }
  if (!browserLogin) {
    server.registerTool("maccabi_login_start", {
      description: "Begin a Maccabi sign-in and send one SMS code to the member's registered phone. The ID number passes through this conversation and into model context; running `maccabi login` in the member's own terminal keeps it out, so offer that first. If several SMS numbers are registered and phone is omitted, the numbered options are returned and no SMS is sent; call again with phone set to one of them. One SMS per call, never resent automatically. The challenge expires ten minutes after this call. Finish with maccabi_login_verify.",
      inputSchema: z.object({ id: z.string().regex(/^\d{1,9}$/, "Use the ID number digits only, at most nine"), phone: z.number().int().min(1).max(999).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, a => withLogin(h => h.start(a.id, a.phone)));
    server.registerTool("maccabi_login_verify", {
      description: "Finish the sign-in started by maccabi_login_start using the six-digit SMS code, and save the session to protected local storage. The code passes through this conversation and into model context. One attempt only: a wrong code ends the challenge and maccabi_login_start must be called again, because repeated attempts lock the Maccabi account. After this succeeds, every account tool works.",
      inputSchema: z.object({ code: z.string().regex(/^\d{6}$/, "Use the six digits from the SMS") }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, a => withLogin(h => h.verify(a.code)));
  }
  server.registerTool("maccabi_login_status", {
    description: "Report whether a session is saved, a started sign-in is still waiting for its SMS code and how many seconds it has left, or nothing is signed in. Call this first when an account read fails and you are unsure why. Local state only: no upstream request, no SMS, no credentials.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, () => withLogin(h => h.status()));
  server.registerTool("maccabi_logout", {
    description: "Delete the locally saved session and any sign-in still waiting for its code. Local only; it does not sign the member out of the Maccabi website or revoke anything upstream. Signing back in costs the member another SMS, so do not call it to clear an error.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, () => withLogin(h => h.logout()));
  register("maccabi_renew_session", "Renew the current owner session once and persist the refreshed cookies, to keep a long-lived server from going idle. Not a clinical read: it changes server-side expiry state. It guarantees no extension duration or continued authentication and cannot reset an open browser's idle/logout countdown. Stops on the first error or reauthentication, with no retries, SMS or background timer.", z.object({}).strict(), r => r.renewSession(), false, false);

  // ---- The two universal resolvers. Everything a list row points at is reached through one of them.
  const refArgument = REF_TOKEN.max(4096);
  const detailSchema = z.object({
    ref: refArgument,
    test_id: id.optional(),
    series_instance_uid: dicomUid.optional(),
    sop_instance_uid: dicomUid.optional(),
    ...pageShape,
  }).strict();
  const documentSchema = z.object({
    ref: refArgument,
    variant: z.enum(["attached_document", "laboratory_report", "english_covid_report", "summary", "comparison_list", "comparison_graph"]).optional(),
    reference: localReference.optional(),
    test_id: id.optional(),
    irregular_only: z.boolean().optional(),
  }).strict();

  const LAB_KINDS = new Set(["test", "latest_labs", "followed_labs"]);
  /**
   * Everything about a ref and its selectors that can be decided without asking Maccabi anything.
   * A caller mistake is answered here, before a session is resolved and a transport is built, so it
   * costs no upstream request and cannot be mistaken for the record being unavailable.
   */
  function preflight(decoded: DecodedRef, tool: "detail" | "document", a: { test_id?: string; reference?: string; series_instance_uid?: string; sop_instance_uid?: string }): string | undefined {
    const kind = decoded.kind;
    if (tool === "detail") {
      if (kind === "referral" || kind === "certificate" || kind === "mailing" || kind === "additional_information" || kind === "hospital_report" || kind === "billing_report" || kind === "nursing_insurance_report") {
        return `A ${kind} row has no structured detail read. Pass this ref to maccabi_document for the original PDF instead.`;
      }
      if ((kind === "latest_labs" || kind === "followed_labs") && a.test_id === undefined) return `A ${kind} ref selects a whole view. Add test_id - any test_id inside that view - to select one analyte.`;
      if (kind !== "imaging_study" && (a.series_instance_uid !== undefined || a.sop_instance_uid !== undefined)) return "series_instance_uid and sop_instance_uid select one image inside an imaging study. This ref is not an imaging study.";
      if (kind === "imaging_study" && (a.series_instance_uid === undefined) !== (a.sop_instance_uid === undefined)) return "Selecting one image needs both series_instance_uid and sop_instance_uid, copied from this study's own series/instances tree.";
      if (!LAB_KINDS.has(kind) && a.test_id !== undefined) return "test_id selects one analyte inside a laboratory result or the latest/followed views. This ref is none of those.";
      return undefined;
    }
    if (kind === "appointment" || kind === "provider" || kind === "vaccination_group" || kind === "directory_provider") return `A ${kind} row has no original document. Use maccabi_detail on this ref instead.`;
    if (kind === "imaging_study") return "An imaging study has no document: its scans live in the external viewer. Use maccabi_detail on this ref for its series and images.";
    if ((kind === "latest_labs" || kind === "followed_labs") && a.test_id === undefined) return `A ${kind} ref selects a whole view. Add test_id - any test_id inside that view - to select one analyte, or use maccabi_report for the whole-view PDF.`;
    if (!LAB_KINDS.has(kind) && a.test_id !== undefined) return "test_id selects one analyte inside a laboratory result or the latest/followed views. This ref is none of those.";
    if (kind === "inquiry" && a.reference === undefined) return "An inquiry's documents are selected by reference: use the list row's pdf_reference for automatic_sick_permit, or a pdf_reference/summary_pdf_reference from maccabi_detail on this same ref.";
    if (kind === "administrative_request" && a.reference === undefined) return "An administrative request's documents are selected by reference: call maccabi_detail on this same ref and use an attachments[].reference from it.";
    if (kind === "mailing" && a.reference === undefined && decoded.payload.reference === undefined) return "This mailing has no document of its own. A type-3 row's documents are its tutorials[].pdf_reference values: pass one as reference.";
    return undefined;
  }
  function selectionError(message: string): CallToolResult {
    return errorResult("INVALID_SELECTION", message, undefined, [{ tool: "maccabi_capabilities", arguments: {}, why: "Which rows carry which reads, and the worked journeys through them." }]);
  }
  function selection(decoded: DecodedRef, testId: string | undefined): LabTestSelection {
    if (testId === undefined) throw new SelectionError(`A ${decoded.kind} ref selects a whole result. Add test_id - any test_id inside that result - to select one analyte.`);
    if (decoded.kind === "test") return { source: "result", requestId: String(decoded.payload.request_id), docId: String(decoded.payload.doc_id), testId };
    return { source: decoded.kind === "latest_labs" ? "latest" : "followed", testId };
  }

  async function detailFor(r: ReaderOperations, decoded: DecodedRef, a: z.output<typeof detailSchema>): Promise<unknown> {
    const p = decoded.payload;
    switch (decoded.kind) {
      case "test": {
        if (a.test_id !== undefined) return withNext(await r.getLabComparison(selection(decoded, a.test_id)), [
          { tool: "maccabi_document", arguments: { ref: a.ref, test_id: a.test_id, variant: "comparison_graph" }, why: "The same comparison as the original PDF, in graph form where the source allows it." },
        ]);
        const result = await r.getLabResult(String(p.request_id), String(p.doc_id));
        const analyte = result.data.results?.[0]?.group_values?.[0]?.test_id;
        return withNext(result, [
          ...(typeof analyte === "string" ? [{ tool: "maccabi_detail", arguments: { ref: a.ref, test_id: analyte }, why: "History for one analyte in this result. Use any results[].group_values[].test_id." }] : []),
          { tool: "maccabi_document", arguments: { ref: a.ref, variant: "laboratory_report" }, why: "The original whole laboratory report PDF for this row." },
        ]);
      }
      case "latest_labs": case "followed_labs":
        return withNext(await r.getLabComparison(selection(decoded, a.test_id)), [
          { tool: "maccabi_document", arguments: { ref: a.ref, test_id: a.test_id, variant: "comparison_graph" }, why: "The same comparison as the original PDF, in graph form where the source allows it." },
        ]);
      case "visit": {
        const result = await r.getVisit(String(p.appointment_id));
        const attachment = findReference(result.data, ["pdf_reference"]);
        return withNext(result, [
          ...(result.data.has_summary_pdf === true ? [{ tool: "maccabi_document", arguments: { ref: a.ref }, why: "The original visit-summary PDF." }] : []),
          ...(attachment ? [{ tool: "maccabi_document", arguments: { ref: a.ref, reference: attachment }, why: "One document attached to this visit. Use any pdf_reference in drugs, referrals, approvals or tutorials." }] : []),
        ]);
      }
      case "inquiry": {
        const result = await r.getInquiry(String(p.request_id));
        const attachment = findReference(result.data, ["pdf_reference", "summary_pdf_reference"]);
        return withNext(result, attachment ? [{ tool: "maccabi_document", arguments: { ref: a.ref, reference: attachment }, why: "One document belonging to this inquiry. Use any pdf_reference or summary_pdf_reference in the payload." }] : []);
      }
      case "administrative_request": {
        const result = await r.getAdministrativeRequest(String(p.interaction_id));
        const attachment = findReference(result.data, ["reference"]);
        return withNext(result, attachment ? [{ tool: "maccabi_document", arguments: { ref: a.ref, reference: attachment }, why: "One eligible attachment or decision print from this correspondence." }] : []);
      }
      case "appointment":
        return r.getFutureAppointment(String(p.reference));
      case "provider":
        return withNext(await r.getAppointmentProvider({ object_type: String(p.object_type), object_id: String(p.object_id), employee_id: String(p.employee_id) }), [
          { tool: "maccabi_appointment_eligibility", arguments: { ref: a.ref }, why: "Whether this member may book with this provider." },
          { tool: "maccabi_clinic_availability", arguments: { ref: a.ref }, why: "The first clinic window this provider offers. It opens a scheduling conversation and stops before any booking." },
        ]);
      case "vaccination_group": {
        const paged = page(await r.getVaccinationDoses(Number(p.vaccine_group_code)), a);
        return withNext(paged, nextPage("maccabi_detail", { ref: a.ref }, paged, a.limit));
      }
      case "prescription": {
        const paged = page(await r.listPrescriptionAlternatives(String(p.doc_id)), a);
        return withNext(paged, [
          ...nextPage("maccabi_detail", { ref: a.ref }, paged, a.limit),
          { tool: "maccabi_document", arguments: { ref: a.ref }, why: "The original prescription PDF, for a digital prescription with purchase status 1, 2 or 3." },
        ]);
      }
      case "imaging_study": {
        const study = String(p.study_instance_uid);
        if (a.series_instance_uid !== undefined || a.sop_instance_uid !== undefined) {
          if (a.series_instance_uid === undefined || a.sop_instance_uid === undefined) throw new SelectionError("Selecting one image needs both series_instance_uid and sop_instance_uid, copied from this study's own series/instances tree.");
          return r.getImagingImage(study, a.series_instance_uid, a.sop_instance_uid);
        }
        const structure = await r.getImagingStudy(study);
        const series = structure.data.series?.[0];
        const instance = series?.instances?.[0];
        return withNext(structure, series && instance ? [
          { tool: "maccabi_detail", arguments: { ref: a.ref, series_instance_uid: series.seriesInstanceUID, sop_instance_uid: instance.sopInstanceUID }, why: "DICOM metadata for one image: geometry, windowing and the decoded transfer syntax. Use any seriesInstanceUID/sopInstanceUID pair from this tree." },
        ] : []);
      }
      default:
        throw new SelectionError(`A ${decoded.kind} row has no structured detail read. Pass this ref to maccabi_document for the original PDF instead.`);
    }
  }

  async function documentFor(r: ReaderOperations, decoded: DecodedRef, a: z.output<typeof documentSchema>): Promise<ReadResult<Uint8Array>> {
    const p = decoded.payload;
    const range = { from: String(p.from), to: String(p.to) };
    const variant = a.variant;
    const reject = (allowed: string): never => { throw new SelectionError(`variant=${variant} is not a document a ${decoded.kind} row carries. ${allowed}`); };
    switch (decoded.kind) {
      case "test": case "latest_labs": case "followed_labs": {
        if (a.test_id !== undefined || decoded.kind !== "test") {
          const chosen = selection(decoded, a.test_id);
          if (variant === "comparison_list" || variant === "comparison_graph") return r.getLabComparisonPdf(chosen, variant === "comparison_graph" ? "graph" : "list");
          if (variant !== undefined && variant !== "attached_document") reject("With test_id, use attached_document for that row's own attached result, or comparison_list/comparison_graph.");
          return r.getLabResultFilePdf(chosen);
        }
        if (variant === "laboratory_report") return a.irregular_only === undefined ? r.getLabReportPdf(String(p.request_id), String(p.doc_id)) : r.getLabReportPdf(String(p.request_id), String(p.doc_id), { irregularOnly: a.irregular_only });
        if (variant === "english_covid_report") return r.getEnglishCovidLabReportPdf(String(p.request_id), String(p.doc_id));
        if (variant !== undefined && variant !== "attached_document") reject("A test row carries attached_document, laboratory_report or english_covid_report; add test_id for one analyte's attachment or comparison.");
        return r.getImagingResultPdf(String(p.request_id), String(p.doc_id));
      }
      case "visit":
        if (a.reference !== undefined) return r.getVisitDocumentPdf(String(p.appointment_id), a.reference);
        if (variant !== undefined && variant !== "summary") reject("A visit carries its summary, or one attachment selected by reference.");
        return r.getVisitSummaryPdf(String(p.appointment_id));
      case "inquiry":
        if (a.reference === undefined) throw new SelectionError("An inquiry's documents are selected by reference: use the list row's pdf_reference for automatic_sick_permit, or a pdf_reference/summary_pdf_reference from maccabi_detail on this same ref.");
        return r.getInquiryDocumentPdf(String(p.request_id), a.reference);
      case "administrative_request":
        if (a.reference === undefined) throw new SelectionError("An administrative request's documents are selected by reference: call maccabi_detail on this same ref and use an attachments[].reference from it.");
        return r.getAdministrativeRequestPdf(String(p.interaction_id), a.reference);
      case "prescription": return r.getPrescriptionPdf(String(p.doc_id));
      case "referral": return r.getReferralPdf(String(p.referral_id));
      case "certificate": return r.getCertificatePdf(String(p.reference), range);
      case "additional_information": return r.getAdditionalInformationPdf(String(p.reference), range);
      case "mailing": {
        const reference = a.reference ?? (p.reference === undefined ? undefined : String(p.reference));
        if (reference === undefined) throw new SelectionError("This mailing has no document of its own. A type-3 row's documents are its tutorials[].pdf_reference values: pass one as reference.");
        return r.getNotificationPdf(reference, range);
      }
      case "hospital_report": return r.getHospitalReportPdf(String(p.reference), String(p.as_of), p.from !== undefined && p.to !== undefined ? range : undefined);
      case "billing_report": return r.getQuarterlyBillingReportPdf(String(p.reference), String(p.period));
      case "nursing_insurance_report": return r.getNursingInsuranceReportPdf(String(p.reference));
      default:
        throw new SelectionError(decoded.kind === "imaging_study"
          ? "An imaging study has no document: its scans live in the external viewer. Use maccabi_detail on this ref for its series and images."
          : `A ${decoded.kind} row has no original document. Use maccabi_detail on this ref instead.`);
    }
  }

  server.registerTool("maccabi_detail", {
    description: "Read the full record behind any row a list tool returned. The row is named by its `ref` alone, so identifiers from two different rows can never be paired. What comes back follows the row: a test row gives its laboratory values; a visit, inquiry, administrative request, upcoming appointment or directory provider gives its detail; a vaccination group gives its dose rows; a prescription gives its listed pharmacy alternatives; an imaging study gives its series and images. The other arguments only narrow what is already inside that row, and every one of them is copied verbatim from a payload you already have: `test_id` turns a test, latest-results or followed-results ref into one analyte's history, `series_instance_uid` with `sop_instance_uid` turn an imaging-study ref into one image's DICOM metadata, and `offset`/`limit` page a detail that returns rows. None of them selects a different record: each is checked against the freshly fetched payload the ref names, and a value that belongs to another row or another study is refused rather than fetched. Rows whose only content is a document say so and name maccabi_document.",
    inputSchema: detailSchema, annotations: publicTool,
  }, async a => {
    let decoded: DecodedRef;
    try { decoded = decodeRef(a.ref); } catch (error) { return referenceError(error); }
    const refused = preflight(decoded, "detail", a);
    if (refused) return selectionError(refused);
    if (decoded.kind === "directory_provider") {
      const p = decoded.payload;
      return withDirectory(d => d.getProviderDetails(p.category as "doctors" | "labs-and-therapists", String(p.field), String(p.reference),
        { ...(p.city === undefined ? {} : { city: String(p.city) }), ...(p.name === undefined ? {} : { name: String(p.name) }), ...(p.page === undefined ? {} : { page: Number(p.page) }) }));
    }
    return withOwner(async r => output(await detailFor(r, decoded, a)));
  });
  server.registerTool("maccabi_document", {
    description: `Read the original PDF behind any row a list tool returned, embedded in the reply (maximum ${PDF_LIMIT / 1024 / 1024} MiB). Takes that row's \`ref\`, which already carries the date range, as-of date, period or parent id the download needs, so none of that has to be reassembled. Rows that carry exactly one document need only the ref: certificates, mailings, additional-information entries, hospital reports, quarterly billing reports, nursing-insurance reports, prescriptions and referrals. \`variant\` chooses between documents where a row has several: a test row offers attached_document (default), laboratory_report and english_covid_report, and a visit offers its summary. \`reference\` selects one attachment listed inside a row - a visit document, an inquiry document, an administrative attachment, a mailing tutorial - using a pdf_reference or attachments[].reference value from that row's own detail. \`test_id\` narrows a lab ref to one analyte, whose attached_document, comparison_list and comparison_graph then apply. \`irregular_only\` uses the source's own print checkbox on a laboratory report, not any medical judgement of this server's. All four narrow the ref rather than redirecting it: \`reference\` is looked up in the parent record's own freshly fetched attachment list and never becomes a URL on its own, so a reference taken from another row is refused rather than downloaded. The PDF may print identity details Maccabi put there; its URI is an inline resource, not a download link.`,
    inputSchema: documentSchema, annotations: publicTool,
  }, async a => {
    let decoded: DecodedRef;
    try { decoded = decodeRef(a.ref); } catch (error) { return referenceError(error); }
    const refused = preflight(decoded, "document", a);
    if (refused) return selectionError(refused);
    return withOwner(async r => documentResult(await documentFor(r, decoded, a)));
  });
  const reports = {
    latest_labs: (r: ReaderOperations, irregular?: boolean) => irregular === undefined ? r.getLatestLabResultsPdf() : r.getLatestLabResultsPdf({ irregularOnly: irregular }),
    followed_labs: (r: ReaderOperations) => r.getFollowedLabResultsPdf(),
    allergies: (r: ReaderOperations) => r.getSensitivityPdf(),
    vaccination_certificate: (r: ReaderOperations) => r.getVaccinationCertificatePdf(),
    english_medical_summary: (r: ReaderOperations) => r.getEnglishMedicalSummaryPdf(),
    purchased_medications: (r: ReaderOperations) => r.getMedicationReportPdf(),
  };
  server.registerTool("maccabi_report", {
    description: `Read one of the account-wide original PDFs - the ones that cover the whole record rather than a single row, so they need no reference (maximum ${PDF_LIMIT / 1024 / 1024} MiB). latest_labs is the latest-results report and accepts irregular_only, which ticks the source's own print checkbox; followed_labs is the report for the tests the member follows; allergies is the sensitivity report; vaccination_certificate is the vaccination certificate; english_medical_summary is the English medical summary, which needs the member's English-name and passport profile fields already filled in; purchased_medications is the purchased-medication report. For a document belonging to one row, use maccabi_document. These PDFs print identity details.`,
    inputSchema: z.object({ document: z.enum(Object.keys(reports) as [keyof typeof reports, ...(keyof typeof reports)[]]), irregular_only: z.boolean().optional() }).strict()
      .refine(a => a.irregular_only === undefined || a.document === "latest_labs", { message: "irregular_only applies only to document=latest_labs" }),
    annotations: publicTool,
  }, a => withOwner(async r => documentResult(await (a.document === "latest_labs" ? reports.latest_labs(r, a.irregular_only) : reports[a.document](r)))));

  // ---- Owner reads. Every list row carries the `ref` the two resolvers above take.
  const accountSections = {
    profile: (r: ReaderOperations) => r.getOwnerProfile(),
    contact_details: (r: ReaderOperations) => r.getOwnerContactProfile(),
    authorized_users: (r: ReaderOperations) => r.listAccountAccess(),
    notification_settings: (r: ReaderOperations) => r.getNotificationPreferences(),
    payment_methods: (r: ReaderOperations) => r.getPaymentMethods(),
  };
  register("maccabi_account", "Read one section of the signed-in member's own account record; `section` says which. `profile` is their name, sex and date of birth, which is how you confirm whose record the rest of these tools are reading. `contact_details` is the email address, phone numbers and postal address Maccabi holds. `authorized_users` is who else may view this account, with their names, identification numbers and authorization end dates, plus whether a new authorization can currently be created. `notification_settings` is which notification groups, services and channels the member is registered for, which are restricted, and the contact fields they would be sent to - the settings page, not the messages, which are maccabi_mailings. `payment_methods` is the payment-authorization summary with the bank, card type and last four digits the source shows. The member's national ID, the upstream credentials and full account numbers are excluded, and there is no family data or directory lookup here. The observed account-access state was creation-available; populated authorized users and the notification read are source-backed and offline-tested. Every section is a read: nothing is saved, granted, extended, revoked or paid, nothing is applied to a family member, and the account being read is never switched. For the payer account's outstanding totals use maccabi_payer_account_totals.",
    z.object({ section: z.enum(Object.keys(accountSections) as [keyof typeof accountSections, ...(keyof typeof accountSections)[]]) }).strict(), async (r, a) => accountSections[a.section](r));
  register("maccabi_medical_recommendations", "Read the recommendation text and table from the legacy medical-recommendations page, in the source's own clinical wording. Only the one captured single-section layout is supported, and this is not a complete history of recommendations.", z.object({}).strict(), r => r.getMedicalRecommendations());
  register("maccabi_medical_summary", "Read the legacy summary page that pairs selected medications with selected laboratory results, as text and tables in the source's wording. This is neither a complete medical history nor the English medical summary PDF, which maccabi_report returns.", z.object({}).strict(), r => r.getSelectedMedicalSummary());
  register("maccabi_hospital_visits", "List hospital and emergency-room admissions. `as_of` is required and anchors the lookback the source page applies (three years in the captured settings); an optional paired from/to narrows it and must end no later than as_of. Rows carry a `ref` for maccabi_document, which returns the admission's original report. Retention beyond the lookback is unverified.",
    z.object({ ...pageShape, as_of: date, from: date.optional(), to: date.optional() }).strict().refine(a => a.from === undefined && a.to === undefined || a.from !== undefined && a.to !== undefined && a.from <= a.to && a.to <= a.as_of, { message: "Provide paired from/to, ordered and no later than as_of" }),
    async (r, a) => {
      const dates = a.from && a.to ? { from: a.from, to: a.to } : undefined;
      const result = await r.listHospitalHistory(a.as_of, dates);
      const paged = page(result, a, row => { const reference = text(row.reference); return reference === undefined ? undefined : encodeRef("hospital_report", { reference, as_of: a.as_of, ...dates }); });
      return withNext(paged, [...nextPage("maccabi_hospital_visits", { as_of: a.as_of, ...dates }, paged, a.limit), ...documentStep(paged, "The original report for one admission.")]);
    });
  register("maccabi_mailings", "List the letters, status notices and tutorials Maccabi sent the member, in a required date range. Type 1 is a letter and type 2 a status notice, each with a `reference`; type 3 is a set of tutorials whose PDFs are the tutorials[].pdf_reference values. Rows carry a `ref` for maccabi_document; for a type-3 row pass one of its tutorial references as `reference` as well. Webpage and video links are returned without being fetched. For the notification settings page use maccabi_account with section=notification_settings. Types 2 and 3 are source-backed and offline-tested. No mark-read.",
    z.object({ ...pageShape, from: date, to: date }).strict().refine(a => a.from <= a.to, { message: "from must not be later than to" }),
    async (r, a) => {
      const result = await r.listNotifications({ from: a.from, to: a.to });
      const paged = page(result, a, row => encodeRef("mailing", { from: a.from, to: a.to, ...(typeof row.reference === "string" ? { reference: row.reference } : {}) }));
      return withNext(paged, [...nextPage("maccabi_mailings", { from: a.from, to: a.to }, paged, a.limit), ...documentStep(paged, "The original letter or tutorial PDF. A type-3 row needs one of its tutorials[].pdf_reference values as `reference` too.")]);
    });
  register("maccabi_prescriptions", "List the member's prescriptions and what has been dispensed against them. Optional `status` (all, valid, history, purchased, expired, renewable) and `permanent` filter the same fetched response locally and mark the result as a filtered subset. Rows carry a `ref`: maccabi_document returns the prescription PDF for a digital prescription, and maccabi_detail lists the pharmacy alternatives the source offers for it. `renewable` reports eligibility only and never requests a renewal; a past purchase does not establish current use.",
    z.object({ ...pageShape, status: z.enum(["all", "valid", "history", "purchased", "expired", "renewable"]).optional(), permanent: z.boolean().optional() }).strict(),
    async (r, a) => {
      const filters = a.status !== undefined || a.permanent !== undefined ? { ...(a.status !== undefined ? { status: a.status } : {}), ...(a.permanent !== undefined ? { permanent: a.permanent } : {}) } : undefined;
      const result = await r.listPrescriptions(filters);
      const paged = page(result, a, row => { const doc = text(row.doc_id); return doc === undefined ? undefined : encodeRef("prescription", { doc_id: doc }); });
      const first = firstRef(paged);
      return withNext(paged, [
        ...nextPage("maccabi_prescriptions", { ...(a.status !== undefined ? { status: a.status } : {}), ...(a.permanent !== undefined ? { permanent: a.permanent } : {}) }, paged, a.limit),
        ...(first ? [{ tool: "maccabi_document", arguments: { ref: first }, why: "The original prescription PDF, for a digital prescription with purchase status 1, 2 or 3." },
          { tool: "maccabi_detail", arguments: { ref: first }, why: "The pharmacy alternatives the source lists for this drug. Not a recommendation to change treatment." }] : []),
      ]);
    });
  register("maccabi_referrals", "List the member's referrals. An optional paired from/to uses the source's own date filter. Rows carry a `ref` for maccabi_document, which returns the referral's original PDF.",
    z.object({ ...pageShape, from: date.optional(), to: date.optional() }).strict().refine(a => Boolean(a.from) === Boolean(a.to), { message: "Provide both from and to" }),
    async (r, a) => {
      const dates = a.from && a.to ? { from: a.from, to: a.to } : undefined;
      const result = await r.listReferrals(dates);
      const paged = page(result, a, row => { const id = text(row.referral_id); return id === undefined ? undefined : encodeRef("referral", { referral_id: id }); });
      return withNext(paged, [...nextPage("maccabi_referrals", { ...dates }, paged, a.limit), ...documentStep(paged, "The original referral PDF.")]);
    });
  register("maccabi_medical_certificates", "List medical certificates - sick notes, fitness confirmations and the like - in a required date range, with the issuing clinician, specialization and validity dates. Rows carry a `ref` for maccabi_document, which returns the certificate's original PDF. For the vaccination certificate use maccabi_report instead.",
    z.object({ ...pageShape, from: date, to: date }).strict().refine(a => a.from <= a.to, { message: "from must not be later than to" }),
    async (r, a) => {
      const result = await r.listCertificates({ from: a.from, to: a.to });
      const paged = page(result, a, row => { const reference = text(row.reference); return reference === undefined ? undefined : encodeRef("certificate", { reference, from: a.from, to: a.to }); });
      return withNext(paged, [...nextPage("maccabi_medical_certificates", { from: a.from, to: a.to }, paged, a.limit), ...documentStep(paged, "The original certificate PDF.")]);
    });
  register("maccabi_additional_information", "List the extra material attached to the member's sessions in a required date range: the portal's 'additional information' feed of handouts, explanatory pages and videos, with the practitioner and specialization behind each. Type-1 entries are downloadable and their rows carry a `ref` for maccabi_document; webpage and video entries are listed but never fetched, and no raw URL is returned. Only an empty account response was ever captured, so populated rows and their downloads are unvalidated live.",
    z.object({ ...pageShape, from: date, to: date }).strict().refine(a => a.from <= a.to, { message: "from must not be later than to" }),
    async (r, a) => {
      const result = await r.listAdditionalInformation({ from: a.from, to: a.to });
      const paged = page(result, a, row => typeof row.reference === "string" ? encodeRef("additional_information", { reference: row.reference, from: a.from, to: a.to }) : undefined);
      return withNext(paged, [...nextPage("maccabi_additional_information", { from: a.from, to: a.to }, paged, a.limit), ...documentStep(paged, "The original type-1 document.")]);
    });
  register("maccabi_tests", "List every test result the member has - laboratory panels, imaging, and other result types - newest first, with the test names, execution and result dates. This is the entry point for anything test-shaped. Optional `year` filters execution dates locally. Every row carries a `ref`: maccabi_detail reads a laboratory row's values, units and reference ranges, and maccabi_document returns whatever original document the row has. `has_document` says whether there is one; imaging rows have none, because their scans live in the external viewer that maccabi_imaging_studies reaches. `categories` describes the row types the source recognises.",
    z.object({ ...pageShape, year: z.number().int().min(1000).max(9999).optional() }).strict(), async (r, a) => {
      const result = await r.listTests(a.year === undefined ? {} : { year: a.year });
      const rows = { ...result, data: result.data.tests };
      const paged = page(rows, a, row => { const request = text(row.request_id), doc = text(row.doc_id); return request === undefined || doc === undefined ? undefined : encodeRef("test", { request_id: request, doc_id: doc }); });
      const first = firstRef(paged);
      const withDocument = paged.data.find(row => row.has_document === true)?.ref;
      return withNext({ ...paged, categories: result.data.categories }, [
        ...nextPage("maccabi_tests", a.year === undefined ? {} : { year: a.year }, paged, a.limit),
        ...(first ? [{ tool: "maccabi_detail", arguments: { ref: first }, why: "The structured result behind one row. Each row carries its own ref." }] : []),
        ...(withDocument ? [{ tool: "maccabi_document", arguments: { ref: withDocument }, why: "The original document attached to a row with has_document=true." }] : []),
        ...(first ? [{ tool: "maccabi_document", arguments: { ref: first, variant: "laboratory_report" }, why: "The whole original laboratory report PDF for a laboratory row." }] : []),
      ]);
    });
  register("maccabi_imaging_studies", "List the member's imaging studies: the test rows whose scans are held in the external MedDream viewer Maccabi hands them off to, rather than as an attached document. Each row carries a `ref` for maccabi_detail, which reads the study's series and images from that viewer. The row's request_id is the study's DICOM Study Instance UID, verified byte-for-byte against a live handoff. These rows have no attached document, so maccabi_document correctly refuses them.",
    z.object(pageShape).strict(), async (r, a) => {
      const result = await r.listImagingStudies();
      const paged = page(result, a, row => { const study = text(row.request_id); return study === undefined ? undefined : encodeRef("imaging_study", { study_instance_uid: study }); });
      const first = firstRef(paged);
      return withNext(paged, [
        ...nextPage("maccabi_imaging_studies", {}, paged, a.limit),
        ...(first ? [{ tool: "maccabi_detail", arguments: { ref: first }, why: "The study's series and images, from the external viewer." }] : []),
      ]);
    });
  register("maccabi_latest_labs", "Read the member's most recent laboratory results, grouped as the source groups them, keeping every value, unit, date and message. The result carries one `ref` for the whole latest-results view: pass it to maccabi_detail with any group_values[].test_id for that analyte's history, which can reach further back than this list, or to maccabi_document for that analyte's own attached result. maccabi_report returns the whole latest-results PDF. Paging selects groups, not individual rows. This is not a complete history.",
    z.object(pageShape).strict(), async (r, a) => {
      const result = await r.listLatestLabResults();
      const paged = page(result, a);
      const ref = encodeRef("latest_labs", {});
      const analyte = paged.data[0]?.group_values?.[0]?.test_id;
      return { ...withNext(paged, [
        ...nextPage("maccabi_latest_labs", {}, paged, a.limit),
        ...(typeof analyte === "string" ? [
          { tool: "maccabi_detail", arguments: { ref, test_id: analyte }, why: "History for one analyte. Use any group_values[].test_id from this result." },
          { tool: "maccabi_document", arguments: { ref, test_id: analyte, variant: "comparison_graph" }, why: "That analyte's comparison as the source's own graph PDF." },
        ] : []),
        { tool: "maccabi_report", arguments: { document: "latest_labs" }, why: "The original latest-results report PDF." },
      ]), ref };
    });
  register("maccabi_followed_labs", "Read the laboratory tests the member follows, with their counter and the source's selection options, as one complete envelope. The result carries one `ref` for the followed view: pass it to maccabi_detail with any followed test's test_id for that analyte's history, or to maccabi_document for its attached result or comparison PDF. maccabi_report returns the whole followed-results PDF. The overall output cap applies and there is no local slicing. Source-backed and offline-tested. It never changes which tests are followed.",
    z.object({}).strict(), async r => {
      const result = await r.listFollowedLabResults();
      const ref = encodeRef("followed_labs", {});
      const analyte = result.data.followed_tests?.[0]?.test_id;
      return { ...withNext(result, [
        ...(typeof analyte === "string" ? [{ tool: "maccabi_detail", arguments: { ref, test_id: analyte }, why: "History for one followed analyte. Use any followed_tests[].test_id." }] : []),
        { tool: "maccabi_report", arguments: { document: "followed_labs" }, why: "The original followed-results report PDF." },
      ]), ref };
    });
  register("maccabi_vaccinations", "List the member's vaccinations grouped by vaccine, with the source's group codes, labels, dose counts and first/last dates. Each row carries a `ref` for maccabi_detail, which lists that group's individual dose records. maccabi_report returns the vaccination certificate PDF. This is group-level data and not a complete immunization record.",
    z.object(pageShape).strict(), async (r, a) => {
      const result = await r.listVaccinationGroups();
      const paged = page(result, a, row => Number.isInteger(row.vaccine_group_code) ? encodeRef("vaccination_group", { vaccine_group_code: row.vaccine_group_code }) : undefined);
      const first = firstRef(paged);
      return withNext(paged, [
        ...nextPage("maccabi_vaccinations", {}, paged, a.limit),
        ...(first ? [{ tool: "maccabi_detail", arguments: { ref: first }, why: "The individual dose records in one group." }] : []),
        { tool: "maccabi_report", arguments: { document: "vaccination_certificate" }, why: "The vaccination certificate PDF." },
      ]);
    });
  register("maccabi_allergies", "List the member's recorded drug sensitivities and intolerances - what Maccabi's own record calls sensitivities. maccabi_report returns the sensitivity report PDF. The account capture was empty, so the populated projection is labeled source.schemaEvidence=frontend-field-projection and an unknown shape fails rather than being guessed at. An empty list does not establish absence of allergies: it means this record holds none, which is not the same thing.",
    z.object(pageShape).strict(), async (r, a) => {
      const paged = page(await r.listSensitivities(), a);
      return withNext(paged, [
        ...nextPage("maccabi_allergies", {}, paged, a.limit),
        { tool: "maccabi_report", arguments: { document: "allergies" }, why: "The original sensitivity report PDF." },
      ]);
    });
  register("maccabi_administrative_requests", "List the member's administrative case timeline: approvals, reimbursement claims and funding commitments, with their status. These are the paperwork requests, not medical questions to a doctor - those are maccabi_doctor_inquiries. Each row carries a `ref` for maccabi_detail, which reads the correspondence and its eligible attachments. The live account list was empty, so populated rows are source-backed and offline-tested. Nothing is approved, paid, submitted or marked read.",
    z.object(pageShape).strict(), async (r, a) => {
      const result = await r.listAdministrativeRequests();
      const paged = page(result, a, row => { const interaction = text(row.interaction_id); return interaction === undefined ? undefined : encodeRef("administrative_request", { interaction_id: interaction }); });
      const first = firstRef(paged);
      return withNext(paged, [
        ...nextPage("maccabi_administrative_requests", {}, paged, a.limit),
        ...(first ? [{ tool: "maccabi_detail", arguments: { ref: first }, why: "The correspondence, obligation and decision fields for one request, with its attachment references." }] : []),
      ]);
    });
  register("maccabi_nursing_insurance_reports", "Read the catalog of annual nursing-insurance reports shown on the member's billing page, with their periods, production dates and view labels. Each report carries a `ref` for maccabi_document, which returns the original annual PDF. No individual insured-person attribution and no claim of complete history; the overall output cap applies and there is no period or person selector.",
    z.object({}).strict(), async r => {
      const result = await r.listNursingInsuranceReports();
      const reportRows = result.data.reports.map(report => ({ ...report, ...(report.reference ? { ref: encodeRef("nursing_insurance_report", { reference: report.reference }) } : {}) }));
      const first = reportRows.find(report => report.ref)?.ref;
      return withNext({ ...result, data: { ...result.data, reports: reportRows } },
        first ? [{ tool: "maccabi_document", arguments: { ref: first }, why: "The original annual nursing-insurance report PDF." }] : []);
    });
  register("maccabi_billing_reports", "Read the catalog of quarterly billing reports, with the periods available, the period currently selected, and each report's production date and view label. Each report carries a `ref` for maccabi_document, which returns the original quarterly PDF and already knows which period it belongs to. Optional `period` must exactly match one of the source page's own availablePeriods values. This is the catalog's first page, not itemized charges.",
    z.object({ period: z.string().regex(/^\d{1,4}$/, "Use an exact value from availablePeriods").optional() }).strict(), async (r, a) => {
      const result = await r.listQuarterlyBillingReports(a.period);
      const period = result.data.selectedPeriod.value;
      const reportRows = result.data.reports.map(report => ({ ...report, ...(report.reference ? { ref: encodeRef("billing_report", { reference: report.reference, period }) } : {}) }));
      const first = reportRows.find(report => report.ref)?.ref;
      return withNext({ ...result, data: { ...result.data, reports: reportRows } },
        first ? [{ tool: "maccabi_document", arguments: { ref: first }, why: "The original quarterly billing report PDF for this period." }] : []);
    });
  register("maccabi_payer_account_totals", "Read the outstanding totals for the payer account this member belongs to, from the source's fixed other-payer branch. These are account-level figures labeled source.scope=payer-account-aggregate: they are not this member's personal debt, and the source attributes neither an individual debtor nor a currency. Do not present them as what the member owes. For how this member's own charges are paid, use maccabi_account with section=payment_methods. No payment is made.", z.object({}).strict(), r => r.getOutstandingDebt());
  register("maccabi_doctor_inquiries", "List the medical inquiries the member sent to a doctor or clinic office, with their status. These are clinical questions and their answers, not reimbursement or approval paperwork - that is maccabi_administrative_requests. Each row carries a `ref` for maccabi_detail, which reads the patient and clinician text. An automatic_sick_permit row is list-only: its document is the row's own pdf_reference, passed to maccabi_document as `reference`. Nothing is submitted, cancelled, answered or marked read.",
    z.object(pageShape).strict(), async (r, a) => {
      const result = await r.listInquiries();
      const paged = page(result, a, row => { const request = text(row.request_id); return request === undefined ? undefined : encodeRef("inquiry", { request_id: request }); });
      const first = paged.data[0];
      const permit = paged.data.find(row => typeof row.pdf_reference === "string");
      return withNext(paged, [
        ...nextPage("maccabi_doctor_inquiries", {}, paged, a.limit),
        ...(first ? [{ tool: "maccabi_detail", arguments: { ref: first.ref }, why: "The original patient and clinician text for one inquiry, with its document references." }] : []),
        ...(permit ? [{ tool: "maccabi_document", arguments: { ref: permit.ref, reference: permit.pdf_reference }, why: "The document of an automatic_sick_permit row, straight from the list." }] : []),
      ]);
    });
  register("maccabi_past_visits", "List the member's past visits - who was seen, when, and for what service. For appointments that have not happened yet use maccabi_upcoming_appointments. Each row carries a `ref`: maccabi_detail reads the visit and the documents attached to it, and maccabi_document returns its summary PDF where has_summery_file is true. This does not establish complete lifetime history.",
    z.object(pageShape).strict(), async (r, a) => {
      const result = await r.listVisits();
      const paged = page(result, a, row => { const appointment = text(row.appointment_id); return appointment === undefined ? undefined : encodeRef("visit", { appointment_id: appointment }); });
      // Only a has_summery_file row has a detail the source will serve, so suggesting any other
      // row would hand the caller a ref that cannot be redeemed.
      const withSummary = paged.data.find(row => row.has_summery_file === true)?.ref;
      return withNext(paged, [
        ...nextPage("maccabi_past_visits", {}, paged, a.limit),
        ...(withSummary ? [{ tool: "maccabi_detail", arguments: { ref: withSummary }, why: "The visit's detail and the pdf_reference of each document attached to it." }] : []),
        ...(withSummary ? [{ tool: "maccabi_document", arguments: { ref: withSummary }, why: "The visit-summary PDF of a row whose has_summery_file is true." }] : []),
      ]);
    });
  register("maccabi_upcoming_appointments", "List the member's future appointments, with the date, provider and service. For visits that already happened use maccabi_past_visits. A row for an ordinary provider carries a `ref` for maccabi_detail, which reads that provider's contact details and the visit instructions. The captured account list was empty, so populated rows are a frontend-derived projection retaining source.schemaEvidence and are offline-tested only. Nothing is booked, cancelled or consented to.",
    z.object(pageShape).strict(), async (r, a) => {
      const result = await r.listFutureAppointments();
      const paged = page(result, a, row => typeof row.reference === "string" ? encodeRef("appointment", { reference: row.reference }) : undefined);
      const first = firstRef(paged);
      return withNext(paged, [
        ...nextPage("maccabi_upcoming_appointments", {}, paged, a.limit),
        ...(first ? [{ tool: "maccabi_detail", arguments: { ref: first }, why: "Provider contacts and visit instructions for one appointment. Instruction links are returned, not fetched." }] : []),
      ]);
    });
  register("maccabi_assigned_doctor", "Read which doctor the member was assigned to at a given moment - the ascribed family physician. `as_of` is timezone-free calendar text, YYYY-MM-DDTHH:mm:ss, and is used exactly as written with no timezone interpretation added.", z.object({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "Use timezone-free YYYY-MM-DDTHH:mm:ss") }).strict(), (r, a) => r.getAscribedProvider(a.as_of));
  register("maccabi_recent_providers", "List the providers and clinics this adult member has had appointments with recently, with clinic addresses. Each row carries a `ref`: maccabi_detail reads the clinic, schedule and provider record, maccabi_appointment_eligibility says whether booking is permitted, and maccabi_clinic_availability reads the first free window.",
    z.object(pageShape).strict(), async (r, a) => {
      const result = await r.listRecentProviders();
      const paged = page(result, a, row => { const type = text(row.object_type), object = text(row.object_id), employee = text(row.employee_id); return type === undefined || object === undefined || employee === undefined ? undefined : encodeRef("provider", { object_type: type, object_id: object, employee_id: employee }); });
      const first = firstRef(paged);
      return withNext(paged, [
        ...nextPage("maccabi_recent_providers", {}, paged, a.limit),
        ...(first ? [
          { tool: "maccabi_detail", arguments: { ref: first }, why: "Clinic, schedule and provider details for one row." },
          { tool: "maccabi_appointment_eligibility", arguments: { ref: first }, why: "Whether this member may book with that provider." },
        ] : []),
      ]);
    });
  const providerRef = z.object({ ref: refArgument }).strict();
  /** Registered by hand so a ref for the wrong kind of row is refused before a session is resolved. */
  function registerProviderTool(name: string, description: string, action: (readers: ReaderOperations, reference: { object_type: string; object_id: string; employee_id: string }) => Promise<unknown>, idempotent = true, readOnly = true): void {
    server.registerTool(name, { description, inputSchema: providerRef, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: true } }, async a => {
      let decoded: DecodedRef;
      try { decoded = decodeRef(a.ref); } catch (error) { return referenceError(error); }
      if (decoded.kind !== "provider") return selectionError(`${name} takes a provider ref from maccabi_recent_providers, not a ${decoded.kind} ref.`);
      const p = decoded.payload;
      return withOwner(async r => output(await action(r, { object_type: String(p.object_type), object_id: String(p.object_id), employee_id: String(p.employee_id) })));
    });
  }
  registerProviderTool("maccabi_appointment_eligibility", "Check whether this member may book an appointment with one provider from maccabi_recent_providers, using that row's `ref`. It reports eligibility and books nothing.", (r, reference) => r.checkAppointmentEligibility(reference));
  registerProviderTool("maccabi_clinic_availability", "Read the first clinic window one provider from maccabi_recent_providers has free, using that row's `ref`. It opens a scheduling conversation upstream and chooses clinic mode, then stops before any date or time is selected, so it is neither side-effect-free nor idempotent and it never books. Only the first observed window is covered, and an unknown dialogue branch fails rather than being guessed at.", (r, reference) => r.getClinicAvailability(reference), false, false);
  server.registerResource("coverage", COVERAGE_URI, { title: "Maccabi read coverage and limits", mimeType: "application/json" }, async uri => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(COVERAGE) }] }));
  return server;
}
