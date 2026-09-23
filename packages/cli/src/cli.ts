import { setTimeout as sleep } from "node:timers/promises";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MaccabiAuth, MaccabiReaders, MaccabiTransport, MaccabiError, MaccabiDirectory, isDoctorSpecialtyField,
  ReadOperationError, ReauthenticationRequired, READ_ERROR_GUIDANCE, ISSUES_URL, safeClinical,
  type MaccabiSession, type OwnerIdentity, type ProviderReference, type DateRange,
  type PrescriptionListOptions, type LabTestSelection, type DirectoryCategory,
} from "@maccabi/core";
import { configDirectory, CredentialStore, FilePendingLoginStore, FileSessionStore, PendingLoginStore, removeProtected, SavedLogin, SessionStoreError } from "./store";
import { LoginAuthDriver, LoginDependencies, LoginError, loginStatus, logoutLocal, startLogin, verifyLogin } from "./login";
import { terminalPrompt } from "./prompt";

import { COMMANDS, MCP_COMMAND, VERSION, commandOptions, discovery, help, index, indexDiscovery } from "./commands";
export { HELP } from "./commands";
const DIRECTORY_COMMANDS = ["directory-fields", "directory-cities", "directory-search", "directory-detail"];
const IMAGING_IMAGE_COMMANDS = ["imaging-image", "imaging-thumbnail", "imaging-pixels"];
const IMAGING_STUDY_COMMANDS = ["imaging-study", ...IMAGING_IMAGE_COMMANDS];

type Readers = Pick<MaccabiReaders,
  "getEnglishCovidLabReportPdf" |
  "listNursingInsuranceReports" | "getNursingInsuranceReportPdf" | "getAdministrativeRequest" | "getAdministrativeRequestPdf" | "listPrescriptionAlternatives" |
  "getLabReportPdf" |
  "listFollowedLabResults" | "getFollowedLabResultsPdf" |
  "listLatestLabResults" | "getLatestLabResultsPdf" | "getLabComparison" | "getLabComparisonPdf" |
  "getVisitDocumentPdf" | "getFutureAppointment" |
  "getQuarterlyBillingReportPdf" | "getInquiryDocumentPdf" | "getVisitSummaryPdf" | "listQuarterlyBillingReports" | "renewSession" | "getLabResultFilePdf" | "getPrescriptionPdf" | "getNotificationPdf" | "getSensitivityPdf" | "getAdditionalInformationPdf" | "getOwnerContactProfile" | "getNotificationPreferences" | "listAccountAccess" | "listNotifications" | "getMedicalRecommendations" | "getSelectedMedicalSummary" | "listHospitalHistory" | "getHospitalReportPdf" | "currentOwner" | "getOwnerProfile" | "listPrescriptions" | "listVaccinationGroups" | "getVaccinationDoses" | "getVaccinationCertificatePdf" |
  "getEnglishMedicalSummaryPdf" | "getMedicationReportPdf" | "listCertificates" | "listAdditionalInformation" | "getCertificatePdf" | "getImagingResultPdf" |
  "listImagingStudies" | "getImagingStudy" | "getImagingImage" | "getImagingImageThumbnail" | "getImagingImagePixels" |
  "listSensitivities" | "listInquiries" | "getInquiry" | "listAdministrativeRequests" | "getPaymentMethods" | "getOutstandingDebt" |
  "listReferrals" | "listTests" | "getLabResult" | "listVisits" | "getVisit" | "getReferralPdf" | "listFutureAppointments" |
  "getAscribedProvider" | "listRecentProviders" | "getAppointmentProvider" | "checkAppointmentEligibility" | "getClinicAvailability">;
export interface Connected { readers: Readers; exportSession(): Promise<MaccabiSession> }
export interface CliDependencies {
  store: CredentialStore;
  pending: PendingLoginStore;
  env: NodeJS.ProcessEnv;
  createDirectory?(): Pick<MaccabiDirectory, "listProviderFields" | "listProviderCities" | "searchProviders" | "getProviderDetails">;
  isInteractive(): boolean;
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  signal?: AbortSignal;
  prompt(label: string, hidden?: boolean): Promise<string>;
  connect(session: MaccabiSession, expectedOwner?: OwnerIdentity): Promise<Connected>;
  createAuth(): LoginAuthDriver;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Writes bytes to a new private file. Named for its first caller; imaging bytes use it too. */
  savePdf(path: string, bytes: Uint8Array): Promise<void>;
}
function defaults(): CliDependencies {
  return {
    store: new FileSessionStore(), pending: new FilePendingLoginStore(), env: process.env, prompt: terminalPrompt,
    now: () => performance.now(),
    wait: async (milliseconds, signal) => { await sleep(milliseconds, undefined, { signal }); },
    isInteractive: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
    async connect(session, expectedOwner) {
      const transport = new MaccabiTransport({ session });
      return { readers: await MaccabiReaders.create(transport, expectedOwner), exportSession: () => transport.exportSession() };
    },
    createAuth: () => new MaccabiAuth(),
    stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
    async savePdf(path, bytes) { await writeFile(path, bytes, { mode: 0o600, flag: "wx" }); },
  };
}
class UsageError extends Error {
  constructor(message = "Invalid command or options. Run maccabi --help. Credentials are never accepted as arguments.") { super(message); }
}
interface Args { command: string; flags: Map<string, string | true>; helpFor?: string; topLevel?: true }
/**
 * Typing the bare binary is the cheapest thing an agent can do, so it has to stay cheap to read.
 * `maccabi`, `maccabi --help` and `maccabi --json` all land on the short index; the full catalog is
 * still one word away under the explicit `maccabi help`.
 */
const TOP_LEVEL = ["--help", "-h", "--json"];
function parse(argv: string[]): Args {
  if (argv.every(arg => TOP_LEVEL.includes(arg))) {
    return { command: "help", topLevel: true, flags: new Map(argv.includes("--json") ? [["json", true]] : []) };
  }
  let command = argv[0] ?? "help";
  if (["--help", "-h"].includes(command)) command = "help";
  if (command === "--version") command = "version";
  if (!Object.hasOwn(COMMANDS, command)) throw new UsageError();
  const parsed = new Map<string, string | true>();
  let helpFor: string | undefined;
  if (command !== "help" && argv.slice(1).some(arg => arg === "--help" || arg === "-h")) {
    return { command: "help", helpFor: command, flags: new Map(argv.includes("--json") ? [["json", true]] : []) };
  }
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (command === "help" && !arg.startsWith("-") && !helpFor && (Object.hasOwn(COMMANDS, arg) || arg === MCP_COMMAND)) { helpFor = arg; continue; }
    if (!arg.startsWith("--")) throw new UsageError();
    const key = arg.slice(2);
    if (!commandOptions(command).includes(key) || parsed.has(key)) throw new UsageError();
    if (["json", "verify", "no-input", "irregular-only"].includes(key) || command === "login" && key === "status" || command === "logout" && key === "all") parsed.set(key, true);
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError();
      parsed.set(key, value);
    }
  }
  if (parsed.has("from") !== parsed.has("to")) throw new UsageError("Use --from and --to together, in YYYY-MM-DD format.");
  if (parsed.has("request") !== parsed.has("doc")) throw new UsageError("Result detail/download requires both --request and --doc from the matching returned test summary.");
  if (parsed.has("year") && (parsed.has("request") || !/^[1-9]\d{3}$/.test(String(parsed.get("year"))))) throw new UsageError("Use --year 1000-9999 for the lab list, or --request and --doc for detail.");
  const args = { command, flags: parsed, helpFor };
  if (parsed.has("from")) {
    const from = required(args, "from"), to = required(args, "to");
    if (!validDate(from) || !validDate(to) || from > to) throw new UsageError("Use valid YYYY-MM-DD dates, with --from no later than --to.");
  }
  if (DIRECTORY_COMMANDS.includes(command) && !["doctors", "labs-and-therapists"].includes(required(args, "category"))) throw new UsageError("Use --category doctors or labs-and-therapists.");
  if (["directory-search", "directory-detail"].includes(command) && !isDoctorSpecialtyField(required(args, "field"))) throw new UsageError("Use --field with one exact key returned by directory-fields for this category.");
  if (command === "directory-detail" && !/^provider-[a-f0-9]{32}$/.test(required(args, "reference"))) throw new UsageError("Use --reference from directory-search with the same category, field and search options.");
  if (command === "prescriptions") {
    if (parsed.has("status") && !["all", "valid", "history", "purchased", "expired", "renewable"].includes(required(args, "status"))) throw new UsageError("Use --status all, valid, history, purchased, expired or renewable.");
    if (parsed.has("permanent") && !["true", "false"].includes(required(args, "permanent"))) throw new UsageError("Use --permanent true or false.");
  }
  if (["directory-search", "directory-detail"].includes(command)) {
    if (parsed.has("city") && !isDoctorSpecialtyField(required(args, "city"))) throw new UsageError("Use --city with one exact key returned by directory-cities for this category.");
    if (parsed.has("name")) {
      const name = required(args, "name");
      if (!name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) throw new UsageError("Use a nonempty provider --name of at most 200 characters without control characters.");
    }
    if (parsed.has("page") && (!/^[1-9]\d*$/.test(required(args, "page")) || Number(required(args, "page")) > 1000)) throw new UsageError("Use --page 1-1000 within the directory's reported pages.");
  }
  if (command === "billing-report-pdf") { required(args, "period"); required(args, "reference"); required(args, "out"); }
  if (command === "prescription-alternatives") required(args, "id");
  if (command === "lab-comparison-pdf" && parsed.has("view") && !["list", "graph"].includes(required(args, "view"))) throw new UsageError("Use --view list or graph.");
  if (command === "administrative-request-pdf") { required(args, "id"); required(args, "out"); }
  if (command === "nursing-insurance-report-pdf") required(args, "out");
  if (["administrative-request-pdf", "nursing-insurance-report-pdf"].includes(command) && !/^[a-f0-9]{64}$/.test(required(args, "reference"))) throw new UsageError("Use the lowercase 64-character reference returned by the matching list or detail command.");
  if (parsed.has("period") && !/^\d{1,4}$/.test(required(args, "period"))) throw new UsageError("Use --period with the exact 1-4 digit value returned in availablePeriods.");
  if (command === "keep-alive") {
    const interval = required(args, "interval"), duration = required(args, "duration");
    if (!/^\d+$/.test(interval) || !/^\d+$/.test(duration) || Number(interval) < 60 || Number(interval) > 86400 || Number(duration) < 1 || Number(duration) > 86400) throw new UsageError("Use --interval 60-86400 and --duration 1-86400, in whole seconds. These are caller policy, not a guaranteed session lifetime.");
  }
  if (parsed.has("group")) {
    const group = required(args, "group");
    if (!/^\d+$/.test(group) || !Number.isSafeInteger(Number(group))) throw new UsageError("Use --group with a nonnegative integer code returned by vaccinations.");
  }
  if (["hospital-history", "hospital-pdf"].includes(command) && !validDate(required(args, "as-of"))) throw new UsageError("Use --as-of with a valid YYYY-MM-DD calendar date.");
  if (["hospital-history", "hospital-pdf"].includes(command) && parsed.has("to") && required(args, "to") > required(args, "as-of")) throw new UsageError("Hospital --to must not be later than --as-of.");
  if (command === "provider") {
    const at = required(args, "at");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(at) || !validDate(at.slice(0, 10)) || Number.isNaN(Date.parse(`${at}Z`)) || new Date(`${at}Z`).toISOString().slice(0, 19) !== at) throw new UsageError("Use --at YYYY-MM-DDTHH:mm:ss, a valid timezone-free portal timestamp.");
  }
  if (["referral-pdf", "prescription-pdf", "visit-pdf", "visit-document-pdf", "inquiry-document-pdf"].includes(command)) { required(args, "id"); required(args, "out"); }
  if (["vaccination-pdf", "english-summary-pdf", "medication-report-pdf", "sensitivity-pdf", "latest-labs-pdf", "followed-labs-pdf"].includes(command)) required(args, "out");
  if (["certificates", "certificate-pdf", "additional-information", "notifications", "notification-pdf", "additional-information-pdf"].includes(command)) range(args);
  if (["hospital-pdf", "certificate-pdf", "notification-pdf", "additional-information-pdf", "inquiry-document-pdf", "billing-report-pdf", "visit-document-pdf"].includes(command) && !/^[a-f0-9]{64}$/.test(required(args, "reference"))) throw new UsageError("Use the lowercase 64-character reference returned by the matching list or detail command.");
  if (command === "appointments" && parsed.has("reference") && !/^[a-f0-9]{64}$/.test(required(args, "reference"))) throw new UsageError("Use the lowercase 64-character reference returned by appointments.");
  if (command === "hospital-pdf") { required(args, "reference"); required(args, "out"); }
  if (["certificate-pdf", "notification-pdf", "additional-information-pdf"].includes(command)) { required(args, "reference"); required(args, "out"); }
  if (["imaging-pdf", "lab-report-pdf", "english-covid-lab-report-pdf"].includes(command)) { required(args, "request"); required(args, "doc"); required(args, "out"); }
  if (IMAGING_STUDY_COMMANDS.includes(command)) required(args, "study");
  if (IMAGING_IMAGE_COMMANDS.includes(command)) { required(args, "series"); required(args, "image"); }
  if (["imaging-thumbnail", "imaging-pixels"].includes(command)) required(args, "out");
  for (const flag of ["study", "series", "image"]) {
    // Every one of these is interpolated into a viewer URL path, so the shape is checked before the
    // command runs rather than after a request has already been built out of it.
    if (parsed.has(flag) && !isDicomUid(required(args, flag))) throw new UsageError(`Use --${flag} with a DICOM UID exactly as returned by imaging-studies, imaging-study or imaging-image.`);
  }
  if (["lab-comparison", "lab-comparison-pdf", "lab-file-pdf"].includes(command)) labTestSelection(args);
  if (["lab-comparison-pdf", "lab-file-pdf"].includes(command)) required(args, "out");
  if (["provider-details", "eligibility", "availability"].includes(command)) reference(args);
  if (parsed.has("limit") || parsed.has("offset")) {
    if (parsed.has("request") || ["visits", "inquiries", "administrative-requests"].includes(command) && parsed.has("id") || command === "appointments" && parsed.has("reference")) throw new UsageError("--limit and --offset apply to lists, not detail records.");
    const limit = required(args, "limit"), offset = String(parsed.get("offset") ?? "0");
    if (!/^[1-9]\d*$/.test(limit) || Number(limit) > 1000 || !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) throw new UsageError("Use --limit 1-1000 and an optional nonnegative integer --offset.");
  }
  return args;
}
/** Digits and dots, at most the 64 characters DICOM allows. Nothing else reaches a viewer path. */
function isDicomUid(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^\d+(?:\.\d+)*$/.test(value);
}
function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
function required(args: Args, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== "string") throw new UsageError(`Missing --${name}. Run maccabi help ${args.command}.`);
  return value;
}
function reference(args: Args): ProviderReference {
  return { object_type: required(args, "object-type"), object_id: required(args, "object-id"), employee_id: required(args, "employee-id") };
}
function range(args: Args): DateRange { return { from: required(args, "from"), to: required(args, "to") }; }
function labTestSelection(args: Args): LabTestSelection {
  const source = args.command === "lab-file-pdf" && !args.flags.has("source") && args.flags.has("request") && args.flags.has("doc") ? "result" : required(args, "source");
  const testId = required(args, "test");
  if (source === "result") return { source: "result" as const, requestId: required(args, "request"), docId: required(args, "doc"), testId };
  if (source !== "latest" && source !== "followed") throw new UsageError("Use --source result, latest or followed.");
  if (args.flags.has("request") || args.flags.has("doc")) throw new UsageError("--request and --doc apply only to --source result.");
  return { source, testId };
}

export async function runCli(argv: string[], overrides: Partial<CliDependencies> = {}): Promise<number> {
  const deps = { ...defaults(), ...overrides };
  let args: Args | undefined;
  // Recognize machine errors even when parsing fails; never include caller-supplied values.
  const fail = (code: string, message: string, exitCode: number): number => {
    deps.stderr(argv.includes("--json")
      ? JSON.stringify({ error: { code, message, exitCode } }) + "\n"
      : `${code}: ${message}\n`);
    return exitCode;
  };
  try {
    args = parse(argv);
    // Every printed result goes through safeClinical, the same filter the MCP surface uses, so the two
    // never return different data for the same read. Terminals, shell history and whatever --json is
    // piped into are all places identity fields, credentials and private document paths must not land.
    const output = (value: unknown) => deps.stdout(JSON.stringify(safeClinical(value), null, args!.flags.has("json") ? undefined : 2) + "\n");
    if (args.command === "help") {
      if (args.topLevel) { if (args.flags.has("json")) output(indexDiscovery()); else deps.stdout(index()); return 0; }
      if (args.flags.has("json")) output(discovery(args.helpFor)); else deps.stdout(help(args.helpFor));
      return 0;
    }
    if (args.command === "version") {
      if (args.flags.has("json")) output({ name: "maccabi", version: VERSION }); else deps.stdout(`maccabi ${VERSION}\n`);
      return 0;
    }
    if (DIRECTORY_COMMANDS.includes(args.command)) {
      const directory = deps.createDirectory?.() ?? new MaccabiDirectory();
      const category = required(args, "category") as DirectoryCategory;
      const options = {
        ...(args.flags.has("city") ? { city: required(args, "city") } : {}), ...(args.flags.has("name") ? { name: required(args, "name") } : {}), ...(args.flags.has("page") ? { page: Number(required(args, "page")) } : {}),
      };
      output(args.command === "directory-fields" ? await directory.listProviderFields(category) : args.command === "directory-cities" ? await directory.listProviderCities(category) : args.command === "directory-detail" ? await directory.getProviderDetails(category, required(args, "field"), required(args, "reference"), options) : await directory.searchProviders(category, required(args, "field"), options));
      return 0;
    }
    const login: LoginDependencies = { store: deps.store, pending: deps.pending, createAuth: deps.createAuth, connect: deps.connect };
    if (args.command === "logout") {
      const result = await logoutLocal(login);
      // The browser sign-in writes elsewhere in the same directory: one credential file per member
      // under sessions/, plus the registered clients and live tokens in oauth.json. Removing only
      // session.json would leave a member signed in as far as the HTTP server is concerned, with no
      // supported way to clear it.
      if (args.flags.has("all")) {
        const directory = configDirectory(deps.env);
        try { await rm(join(directory, "sessions"), { recursive: true, force: true }); }
        catch { throw new SessionStoreError(); }
        await removeProtected(join(directory, "oauth.json"));
        output({ ...result, browserSessions: "removed" });
        return 0;
      }
      output(result);
      return 0;
    }
    if (args.command === "login") {
      if (args.flags.has("status")) { output(await loginStatus(login)); return 0; }
      const givenId = args.flags.has("id") ? required(args, "id") : deps.env.MACCABI_ID || undefined;
      const givenCode = args.flags.has("code") ? required(args, "code") : deps.env.MACCABI_OTP || undefined;
      if (givenId !== undefined && givenCode !== undefined) throw new UsageError("Start a login with --id, then finish it with --code, as two separate commands.");
      if (givenCode !== undefined) {
        if (!/^\d{6}$/.test(givenCode)) throw new UsageError("Use --code with the six digits from the SMS. Nothing was verified.");
        output(await verifyLogin(login, givenCode));
        return 0;
      }
      if (givenId !== undefined) {
        if (!/^\d{1,9}$/.test(givenId)) throw new UsageError("Use --id with the ID number digits only, at most nine of them. Nothing was sent.");
        if (args.flags.has("phone") && !/^[1-9]\d{0,2}$/.test(required(args, "phone"))) throw new UsageError("Use --phone with an option number from the list this command prints when several SMS numbers exist.");
        const started = await startLogin(login, givenId, args.flags.has("phone") ? Number(required(args, "phone")) : undefined);
        output(started);
        // Not an error, but the login is unfinished: a shell chaining on success must not continue.
        return started.status === "phone-required" ? 3 : 0;
      }
      if (args.flags.has("no-input") || !deps.isInteractive()) return fail("INTERACTIVE_LOGIN_REQUIRED", "Login needs an interactive terminal, or the two flag steps. Run `maccabi login` without --no-input in a real terminal, or `maccabi login --id <id>` and then `maccabi login --code <code>` (add `--phone <n>` when several SMS numbers are on file). No SMS was sent.", 3);
      await deps.store.load(); // Fail on an unusable session file before requesting credentials or SMS.
      const auth = deps.createAuth();
      try {
        const id = await deps.prompt("ID number: ", true);
        const challenge = await auth.beginLogin(id);
        const choices = challenge.phones.filter(phone => phone.smsAvailable);
        let selected = choices[0]?.index;
        if (choices.length > 1) {
          for (const phone of choices) deps.stderr(`${phone.index + 1}. ${phone.label}\n`);
          const answer = await deps.prompt("Choose SMS phone number: ");
          if (!/^\d+$/.test(answer)) throw new UsageError();
          selected = Number(answer) - 1;
        }
        await auth.requestOtp(challenge.id, selected);
        // A single usable number is not a menu: report the send instead of numbering one option.
        // `display` (not `label`) here: a sentence takes the bare value, not the menu's "Phone " prefix.
        if (choices.length === 1) deps.stderr(`Code sent by SMS to ${choices[0].display}\n`);
        const otp = await deps.prompt("SMS code: ", true);
        const session = await auth.completeLogin(challenge.id, otp);
        const expectedOwner = { memberId: Number.parseInt(id, 10), memberIdCode: "0" };
        const connected = await deps.connect(session, expectedOwner);
        await deps.store.save({ session: await connected.exportSession(), owner: connected.readers.currentOwner });
        output({ status: "signed-in", persistence: "session-file" });
        return 0;
      } catch (error) {
        await auth.cancelLogin().catch(() => {});
        throw error;
      }
    }
    const saved = await deps.store.load();
    if (args.command === "status" && !args.flags.has("verify")) {
      output({ status: saved ? "saved" : "signed-out", verified: false, ...expiryEstimate(saved?.session) });
      return 0;
    }
    if (!saved) return fail("AUTH_REQUIRED", "No saved session. Run `maccabi login` in an interactive terminal, or `maccabi login --id <id>` and then `maccabi login --code <code>` (add `--phone <n>` when several SMS numbers are on file). No SMS was sent.", 3);
    const connected = await deps.connect(saved.session, saved.owner);
    const readers = connected.readers;
    if (args.command === "keep-alive") {
      output(await keepAlive(connected, args, deps));
      return 0;
    }
    let result: unknown;
    switch (args.command) {
      case "renew-session": result = await readers.renewSession(); break;
      case "status": result = { status: "signed-in", verified: true, ...expiryEstimate(saved.session) }; break;
      case "recommendations": result = await readers.getMedicalRecommendations(); break;
      case "medical-summary": result = await readers.getSelectedMedicalSummary(); break;
      case "hospital-history": result = await readers.listHospitalHistory(required(args, "as-of"), args.flags.has("from") ? range(args) : undefined); break;
      case "contact-profile": result = readers.getOwnerContactProfile(); break;
      case "notification-preferences": result = await readers.getNotificationPreferences(); break;
      case "account-access": result = await readers.listAccountAccess(); break;
      case "notifications": result = await readers.listNotifications(range(args)); break;
      case "profile": result = readers.getOwnerProfile(); break;
      case "latest-labs": result = await readers.listLatestLabResults(); break;
      case "followed-labs": result = await readers.listFollowedLabResults(); break;
      case "nursing-insurance-reports": result = await readers.listNursingInsuranceReports(); break;
      case "prescription-alternatives": result = await readers.listPrescriptionAlternatives(required(args, "id")); break;
      case "lab-comparison": result = await readers.getLabComparison(labTestSelection(args)); break;
      case "prescriptions": result = await readers.listPrescriptions(args.flags.has("status") || args.flags.has("permanent") ? { ...(args.flags.has("status") ? { status: required(args, "status") as PrescriptionListOptions["status"] } : {}), ...(args.flags.has("permanent") ? { permanent: required(args, "permanent") === "true" } : {}) } : undefined); break;
      case "vaccinations": result = args.flags.has("group") ? await readers.getVaccinationDoses(Number(required(args, "group"))) : await readers.listVaccinationGroups(); break;
      case "sensitivities": result = await readers.listSensitivities(); break;
      case "inquiries": result = args.flags.has("id") ? await readers.getInquiry(required(args, "id")) : await readers.listInquiries(); break;
      case "administrative-requests": result = args.flags.has("id") ? await readers.getAdministrativeRequest(required(args, "id")) : await readers.listAdministrativeRequests(); break;
      case "payment-methods": result = await readers.getPaymentMethods(); break;
      case "billing-reports": result = await readers.listQuarterlyBillingReports(args.flags.has("period") ? required(args, "period") : undefined); break;
      case "billing-totals": result = await readers.getOutstandingDebt(); break;
      case "certificates": result = await readers.listCertificates(range(args)); break;
      case "additional-information": result = await readers.listAdditionalInformation(range(args)); break;
      case "referrals": result = await readers.listReferrals(args.flags.has("from") ? { from: required(args, "from"), to: required(args, "to") } : undefined); break;
      case "imaging-studies": result = await readers.listImagingStudies(); break;
      case "imaging-study": result = await readers.getImagingStudy(required(args, "study")); break;
      case "imaging-image": result = await readers.getImagingImage(required(args, "study"), required(args, "series"), required(args, "image")); break;
      case "imaging-thumbnail": {
        const file = await readers.getImagingImageThumbnail(required(args, "study"), required(args, "series"), required(args, "image"));
        await deps.savePdf(required(args, "out"), file.data);
        result = { status: "saved", mimeType: "image/jpeg", bytes: file.data.byteLength, retrievedAt: file.retrievedAt, source: file.source };
        break;
      }
      case "imaging-pixels": {
        const file = await readers.getImagingImagePixels(required(args, "study"), required(args, "series"), required(args, "image"));
        // The buffer has no header, so the geometry is not a nicety: printing it is the only way the
        // saved file is readable at all. The bytes themselves never go to stdout.
        const { pixels, ...geometry } = file.data;
        await deps.savePdf(required(args, "out"), pixels);
        result = { status: "saved", mimeType: "application/octet-stream", bytes: pixels.byteLength, geometry, retrievedAt: file.retrievedAt, source: file.source };
        break;
      }
      case "labs": result = args.flags.has("request") ? await readers.getLabResult(required(args, "request"), required(args, "doc")) : await readers.listTests(args.flags.has("year") ? { year: Number(required(args, "year")) } : undefined); break;
      case "visits": result = args.flags.has("id") ? await readers.getVisit(required(args, "id")) : await readers.listVisits(); break;
      case "appointments": result = args.flags.has("reference") ? await readers.getFutureAppointment(required(args, "reference")) : await readers.listFutureAppointments(); break;
      case "provider": result = await readers.getAscribedProvider(required(args, "at")); break;
      case "recent-providers": result = await readers.listRecentProviders(); break;
      case "provider-details": result = await readers.getAppointmentProvider(reference(args)); break;
      case "eligibility": result = await readers.checkAppointmentEligibility(reference(args)); break;
      case "availability": result = await readers.getClinicAvailability(reference(args)); break;
      case "referral-pdf":
      case "vaccination-pdf":
      case "medication-report-pdf":
      case "certificate-pdf":
      case "billing-report-pdf":
      case "visit-pdf":
      case "visit-document-pdf":
      case "inquiry-document-pdf":
      case "lab-file-pdf":
      case "nursing-insurance-report-pdf":
      case "administrative-request-pdf":
      case "lab-report-pdf":
      case "english-covid-lab-report-pdf":
      case "latest-labs-pdf":
      case "followed-labs-pdf":
      case "lab-comparison-pdf":
      case "prescription-pdf":
      case "notification-pdf":
      case "sensitivity-pdf":
      case "additional-information-pdf":
      case "hospital-pdf":
      case "imaging-pdf":
      case "english-summary-pdf": {
        const downloads = {
          "nursing-insurance-report-pdf": () => readers.getNursingInsuranceReportPdf(required(args!, "reference")),
          "administrative-request-pdf": () => readers.getAdministrativeRequestPdf(required(args!, "id"), required(args!, "reference")),
          "lab-report-pdf": () => args!.flags.has("irregular-only") ? readers.getLabReportPdf(required(args!, "request"), required(args!, "doc"), { irregularOnly: true }) : readers.getLabReportPdf(required(args!, "request"), required(args!, "doc")),
          "english-covid-lab-report-pdf": () => readers.getEnglishCovidLabReportPdf(required(args!, "request"), required(args!, "doc")),
          "latest-labs-pdf": () => args!.flags.has("irregular-only") ? readers.getLatestLabResultsPdf({ irregularOnly: true }) : readers.getLatestLabResultsPdf(),
          "followed-labs-pdf": () => readers.getFollowedLabResultsPdf(),
          "lab-comparison-pdf": () => args!.flags.has("view") ? readers.getLabComparisonPdf(labTestSelection(args!), required(args!, "view") as "list" | "graph") : readers.getLabComparisonPdf(labTestSelection(args!)),
          "billing-report-pdf": () => readers.getQuarterlyBillingReportPdf(required(args!, "reference"), required(args!, "period")),
          "visit-pdf": () => readers.getVisitSummaryPdf(required(args!, "id")),
          "visit-document-pdf": () => readers.getVisitDocumentPdf(required(args!, "id"), required(args!, "reference")),
          "inquiry-document-pdf": () => readers.getInquiryDocumentPdf(required(args!, "id"), required(args!, "reference")),
          "lab-file-pdf": () => readers.getLabResultFilePdf(labTestSelection(args!)),
          "prescription-pdf": () => readers.getPrescriptionPdf(required(args!, "id")),
          "notification-pdf": () => readers.getNotificationPdf(required(args!, "reference"), range(args!)),
          "sensitivity-pdf": () => readers.getSensitivityPdf(),
          "additional-information-pdf": () => readers.getAdditionalInformationPdf(required(args!, "reference"), range(args!)),
          "referral-pdf": () => readers.getReferralPdf(required(args!, "id")),
          "vaccination-pdf": () => readers.getVaccinationCertificatePdf(),
          "medication-report-pdf": () => readers.getMedicationReportPdf(),
          "english-summary-pdf": () => readers.getEnglishMedicalSummaryPdf(),
          "certificate-pdf": () => readers.getCertificatePdf(required(args!, "reference"), range(args!)),
          "hospital-pdf": () => readers.getHospitalReportPdf(required(args!, "reference"), required(args!, "as-of"), args!.flags.has("from") ? range(args!) : undefined),
          "imaging-pdf": () => readers.getImagingResultPdf(required(args!, "request"), required(args!, "doc")),
        };
        const file = await downloads[args.command]();
        await deps.savePdf(required(args, "out"), file.data);
        result = { status: "saved", bytes: file.data.byteLength };
        break;
      }
    }
    await deps.store.save({ session: await connected.exportSession(), owner: readers.currentOwner });
    output(selectPage(result, args));
    return 0;
  } catch (error) {
    // Only a real reauthentication removes the stored session. A selected dependent and a saved owner
    // that no longer matches are both live sessions, and deleting one costs the member an SMS login.
    // Removal on a genuine expiry is intended, not incidental: the credential is dead upstream, the
    // transport has already cleared the jar it came from, and nothing in the file is diagnosable
    // afterwards. The MCP server deletes on this same one condition and says the same sentence, so
    // a member gets the same answer whichever surface they were using.
    if (!DIRECTORY_COMMANDS.includes(args?.command ?? "") && error instanceof ReauthenticationRequired) {
      try { await deps.store.delete(); }
      catch {
        return fail("SESSION_REMOVAL_FAILED", "The saved session needs a new login, but its file could not be removed. Check the config directory permissions and run maccabi logout.", 1);
      }
      return fail("AUTH_REQUIRED", "Maccabi rejected the saved session as expired, so it has been removed from local storage; there is nothing left to repair. Run `maccabi login` in an interactive terminal, or `maccabi login --id <id>` and then `maccabi login --code <code>` (add `--phone <n>` when several SMS numbers are on file). No automatic SMS retry was made.", 3);
    }
    if (error instanceof UsageError) return fail("INVALID_USAGE", error.message, 2);
    if (error instanceof LoginError) return fail(error.code, error.message, 3);
    if (error instanceof SessionStoreError) return fail("SESSION_STORE_UNAVAILABLE", error.message, 1);
    if (error instanceof MaccabiError && error.code === "REQUEST_TIMEOUT") return fail("REQUEST_TIMEOUT", "The Maccabi request timed out. Check connectivity and try again when ready; no automatic login or SMS retry was made.", 1);
    if (error instanceof MaccabiError && error.code === "REQUEST_ABORTED") return fail("REQUEST_ABORTED", "The Maccabi request was cancelled. No automatic login or SMS retry was made.", 1);
    if (error instanceof MaccabiError && error.code === "DIRECTORY_CONFIGURATION_UNAVAILABLE") return fail(error.code, "The public site did not supply the expected search configuration. Check the official doctor directory in your browser; no search was submitted.", 1);
    if (error instanceof MaccabiError && DIRECTORY_COMMANDS.includes(args?.command ?? "")) return fail(error.code, "Public directory request failed. Use a current field from directory-fields for the selected category and check connectivity; no account session was used.", 1);
    if (error instanceof MaccabiError) return fail(error.code, "Maccabi operation failed. No automatic login or SMS retry was made.", 1);
    if (error instanceof ReadOperationError) return fail(error.code, READ_ERROR_GUIDANCE[error.code](error.operation), 1);
    // Nothing above matched, so this is the one branch that means the failure was never anticipated.
    // A usage mistake or a missing login exits through their own branches and is deliberately not sent here.
    return fail("COMMAND_FAILED", `The command could not complete. Check storage and output-file permissions; no automatic retry was made. If that is not it, this is a defect in this client - please report it at ${ISSUES_URL}.`, 1);
  }
}

const EXPIRY_NOTE = "Estimated absolute cap read from the local session cookie; no request was made. Maccabi also ends an idle session well before this, so run `maccabi keep-alive` to hold one open.";
/**
 * F5 BIG-IP puts the session's own absolute deadline in F5_ST as `1z1z1z<start>z<timeout>`, both in
 * seconds. Reading it costs nothing and tells the member when a new login becomes unavoidable. The
 * cookie value itself never leaves this function.
 */
function expiryEstimate(session: MaccabiSession | undefined): { expiresAt: string; expiryNote: string } | Record<string, never> {
  const value = session?.cookies.cookies.find(cookie => cookie.key === "F5_ST")?.value;
  if (typeof value !== "string") return {};
  const fields = value.split("z");
  if (fields.length !== 5 || fields.some(field => !/^\d+$/.test(field))) return {};
  // A cookie carrying absurd digits parses but is not a date; reporting nothing beats throwing in `status`.
  const expiry = new Date((Number(fields[3]) + Number(fields[4])) * 1000);
  if (Number.isNaN(expiry.getTime())) return {};
  return { expiresAt: expiry.toISOString(), expiryNote: EXPIRY_NOTE };
}

async function keepAlive(connected: Connected, args: Args, deps: CliDependencies) {
  const controller = new AbortController();
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const started = deps.now(), deadline = started + Number(required(args, "duration")) * 1000;
  const interval = Number(required(args, "interval")) * 1000;
  let renewals = 0;
  try {
    if (!args.flags.has("json")) deps.stderr("Sending best-effort renewal requests for the requested finite duration. Interrupt to stop; browser idle/logout timers are unaffected and continued authentication is not guaranteed.\n");
    while (!signal.aborted && deps.now() < deadline) {
      await connected.readers.renewSession();
      await deps.store.save({ session: await connected.exportSession(), owner: connected.readers.currentOwner });
      renewals++;
      if (signal.aborted || deps.now() >= deadline) break;
      try { await deps.wait(Math.min(interval, deadline - deps.now()), signal); }
      catch (error) { if (!signal.aborted) throw error; }
    }
    return { status: signal.aborted ? "cancelled" : "completed", renewals, elapsedSeconds: Math.floor((deps.now() - started) / 1000) };
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

/** Explicit local slicing preserves records and source provenance, and never implies server pagination. */
function selectPage(result: unknown, args: Args): unknown {
  if (!args.flags.has("limit")) return result;
  const value = result as { data: unknown };
  const tests = COMMANDS[args.command]!.collection === "tests";
  const rows = tests ? (value.data as { tests: unknown[] }).tests : value.data as unknown[];
  if (!Array.isArray(rows)) throw new Error("Unexpected list result");
  const offset = Number(args.flags.get("offset") ?? 0), limit = Number(args.flags.get("limit"));
  const selected = rows.slice(offset, offset + limit);
  return {
    ...value,
    data: tests ? { ...(value.data as object), tests: selected } : selected,
    page: { mode: "local", offset, limit, returned: selected.length, availableInResponse: rows.length, hasMoreInResponse: offset + selected.length < rows.length, upstreamTotalKnown: false },
  };
}
