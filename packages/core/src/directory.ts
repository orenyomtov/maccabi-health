import { load } from "cheerio/slim";
import { createHash, randomUUID } from "node:crypto";
import { MaccabiError, UpstreamError } from "./errors";
import { readResponseBody, type FetchFunction } from "./transport";
import type { ReadResult } from "./readers";
import { projectDirectoryDetails, type DirectoryProviderDetails } from "./directory-detail";
export type { DirectoryProviderDetails } from "./directory-detail";

const ORIGIN = "https://serguide.maccabi4u.co.il";
const ENTRY = ORIGIN + "/heb/doctors/";
const SEARCH = ORIGIN + "/webapi/api/SearchPage/GetSearchPageSearch/";
const SETTINGS = ORIGIN + "/webapi/api/SettingsForSearch/GetSettingsForSearch/";
const DETAILS = ORIGIN + "/webapi/api/ProviderDetails/";
export type DirectoryCategory = "doctors" | "labs-and-therapists";
const CATEGORIES = {
  doctors: { chapter: "001", module: "doctors", config: "Doctors_001" },
  "labs-and-therapists": { chapter: "003", module: "labsandtherapists", config: "LabsAndTherapists_003" },
} as const;
function categoryDefinition(category: DirectoryCategory) {
  if (category !== "doctors" && category !== "labs-and-therapists") throw new UpstreamError("DIRECTORY_INVALID_CATEGORY");
  return CATEGORIES[category];
}
const MAX_BODY = 4 * 1024 * 1024;
export interface DoctorSpecialty { field: string; label: string }
export interface DoctorCity { city: string; label: string }
export interface DoctorSearchOptions { city?: string; name?: string; page?: number }
/** Original public display fields, without opaque navigation or appointment parameters. */
export interface DirectoryDoctor {
  reference: string;
  TITEL: string; FIRST_NAME: string; LAST_NAME: string; SERVICE_NAME: string;
  TREAT_AREA_1: string; TREAT_AREA_2: string; TREAT_AREA_3: string;
  TREAT_AREA_4: string; TREAT_AREA_5: string; TREAT_AREA_6: string;
  CITY_NAME: string; PARTIALLY_ADRESS: string;
  PHONENUMBERS: { Title: string; Value: string }[];
}
export interface DoctorSearchResult {
  specialty: DoctorSpecialty;
  providers: DirectoryDoctor[];
  filters: { city?: DoctorCity; name?: string };
  coverage: { page: number; returned: number; reportedTotalItems: number; reportedTotalPages: number; pagingSupported: true };
}
export interface ProviderSearchResult extends Omit<DoctorSearchResult, "specialty"> {
  category: DirectoryCategory;
  field: DoctorSpecialty;
  /** Supply this same context with a returned provider reference for a fresh, independently bound detail read. */
  selection: { category: DirectoryCategory; field: string; options: DoctorSearchOptions };
}
export interface DirectoryOptions { fetch?: FetchFunction; timeoutMs?: number }
const invalid = () => new UpstreamError("DIRECTORY_INVALID_RESPONSE");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_384) throw invalid();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}
function numericIdentity(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[0-9]+$/.test(value))) throw invalid();
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw invalid();
  return numeric;
}
/** One catalog key, not the source's comma-joined multi-specialty filter. */
export function isDoctorSpecialtyField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[,\s\u0000-\u001f\u007f]/u.test(value);
}

/** Parse only the public JSON assignment; never execute the application script. */
function configurationFromHtml(html: string): Record<string, unknown> {
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: false } }, false);
  const scripts = $("script:not([src])").toArray().map(element => $(element).text());
  const candidates = scripts.filter(value => /\b__INITIAL_STATE__\s*=/.test(value));
  if (candidates.length === 0) throw new MaccabiError("DIRECTORY_CONFIGURATION_UNAVAILABLE", "The public site did not supply the expected search configuration. Check the official doctor directory in your browser; no search was submitted.");
  if (candidates.length !== 1) throw invalid();
  const candidate = candidates[0];
  const assignments = [...candidate.matchAll(/\b__INITIAL_STATE__\s*=\s*/g)];
  if (assignments.length !== 1) throw invalid();
  const start = assignments[0].index! + assignments[0][0].length;
  if (candidate[start] !== "{") throw invalid();
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let index = start; index < candidate.length; index++) {
    const char = candidate[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { end = index + 1; break; }
  }
  if (end < 0 || !/^\s*;/.test(candidate.slice(end))) throw invalid();
  let state: unknown;
  try { state = JSON.parse(candidate.slice(start, end)); } catch { throw invalid(); }
  const doctors = record(record(record(state).settings).doctors);
  if (record(doctors.Settings).category !== "Doctors_001") throw invalid();
  return record(doctors.Data);
}
function catalogFromConfiguration(data: Record<string, unknown>, key: "Fields" | "Cities"): { key: string; label: string }[] {
  const fields = data[key];
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 2_000) throw invalid();
  const seen = new Set<string>();
  return fields.map(value => {
    const row = record(value);
    if (!isDoctorSpecialtyField(row.K) || seen.has(row.K) || typeof row.V !== "string" || !row.V.trim() || row.V.length > 1_024) throw invalid();
    seen.add(row.K);
    return { key: row.K, label: row.V };
  });
}

/** Anonymous doctor search. Paging and optional filters follow the public result-page controller. */
export class MaccabiDirectory {
  readonly #fetch: FetchFunction;
  readonly #timeoutMs: number;
  constructor(options: DirectoryOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new UpstreamError("INVALID_TIMEOUT");
  }
  async listProviderFields(category: DirectoryCategory): Promise<ReadResult<DoctorSpecialty[]>> {
    const data = await this.#configuration(category);
    return this.#result(catalogFromConfiguration(data, "Fields").map(row => ({ field: row.key, label: row.label })), "provider-fields");
  }
  async listProviderCities(category: DirectoryCategory): Promise<ReadResult<DoctorCity[]>> {
    const data = await this.#configuration(category);
    return this.#result(catalogFromConfiguration(data, "Cities").map(row => ({ city: row.key, label: row.label })), "provider-cities");
  }
  async searchProviders(category: DirectoryCategory, field: string, options: DoctorSearchOptions = {}): Promise<ReadResult<ProviderSearchResult>> {
    const searched = await this.#search(category, field, options);
    return this.#result(searched.result, "provider-search");
  }
  async getProviderDetails(category: DirectoryCategory, field: string, reference: string, options: DoctorSearchOptions = {}): Promise<ReadResult<DirectoryProviderDetails>> {
    categoryDefinition(category);
    if (typeof reference !== "string" || !/^provider-[a-f0-9]{32}$/.test(reference)) throw new UpstreamError("DIRECTORY_INVALID_REFERENCE");
    const searched = await this.#search(category, field, options);
    const found = searched.references.get(reference);
    if (!found) throw new UpstreamError("DIRECTORY_REFERENCE_NOT_FOUND");
    const value = this.#json(await this.#request(DETAILS, "application/json", {
      ItemKeyIndex: found.itemKey, Source: "SearchPageResults", RequestId: searched.requestId,
      ChapterId: categoryDefinition(category).chapter, InitiatorCode: "001", IsKosher: 0, IsMobileApplication: 0,
    }));
    if (value.Success !== true || value.ErrorCode !== 0) throw new UpstreamError("DIRECTORY_DETAIL_FAILED");
    if (value.Chapter_Code !== categoryDefinition(category).chapter || numericIdentity(value.PositionId) !== found.position ||
        (category === "labs-and-therapists" && found.employee === 0 ? value.Pernr !== "" : numericIdentity(value.Pernr) !== found.employee) ||
        value.City_Name !== found.city || value.Service_Name !== found.service) throw invalid();
    return this.#result(projectDirectoryDetails(value, reference), "provider-detail");
  }
  async #configuration(category: DirectoryCategory): Promise<Record<string, unknown>> {
    const definition = categoryDefinition(category);
    if (category === "doctors") return configurationFromHtml(await this.#request(ENTRY, "text/html"));
    const config = this.#json(await this.#request(SETTINGS, "application/json", { ModuleName: definition.module, initiatorCode: "001" }));
    if (record(config.Settings).category !== definition.config) throw invalid();
    return record(config.Data);
  }
  async #search(category: DirectoryCategory, field: string, options: DoctorSearchOptions) {
    const definition = categoryDefinition(category);
    if (!isDoctorSpecialtyField(field)) throw new UpstreamError("DIRECTORY_INVALID_FIELD");
    const page = options.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000) throw new UpstreamError("DIRECTORY_INVALID_PAGE");
    if (options.city !== undefined && !isDoctorSpecialtyField(options.city)) throw new UpstreamError("DIRECTORY_INVALID_CITY");
    if (options.name !== undefined && (typeof options.name !== "string" || !options.name.trim() || options.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(options.name))) throw new UpstreamError("DIRECTORY_INVALID_NAME");
    const config = await this.#configuration(category);
    const item = catalogFromConfiguration(config, "Fields").find(row => row.key === field);
    if (!item) throw new UpstreamError("DIRECTORY_UNKNOWN_FIELD");
    const specialty = { field: item.key, label: item.label };
    const city = options.city === undefined ? undefined : catalogFromConfiguration(config, "Cities").find(row => row.key === options.city);
    if (options.city !== undefined && !city) throw new UpstreamError("DIRECTORY_UNKNOWN_CITY");
    const query = {
      Field: field, ...(city ? { City: city.key } : {}), ...(options.name !== undefined ? { DocName: options.name } : {}),
      ChapterId: definition.chapter, InitiatorCode: "001", isKosher: 0, IsMobileApplication: 0, PageNumber: 1, RequestId: randomUUID(),
    };
    let result = this.#searchResponse(await this.#request(SEARCH, "application/json", query));
    if (page > 1) {
      if (page > count(result.NumOfPages)) throw new UpstreamError("DIRECTORY_PAGE_OUT_OF_RANGE");
      // The observed Next request preserves the search context and uses a numeric page without a tab parameter.
      if (result.SelectedTab !== null && (typeof result.SelectedTab !== "string" || !/^[1-9][0-9]?$/.test(result.SelectedTab))) throw invalid();
      const selectedTab = result.SelectedTab;
      result = this.#searchResponse(await this.#request(SEARCH, "application/json", {
        ...query, PageNumber: page, Source: "SearchPage", ModuleName: definition.module + "searchresults",
      }));
      if (result.SelectedTab !== selectedTab || count(result.NumOfPages) < page) throw invalid();
    }
    const reportedTotalItems = count(result.TotalItems), reportedTotalPages = count(result.NumOfPages);
    const items = result.Items as unknown[];
    const references = new Map<string, { itemKey: string; position: number; employee: number; city: string; service: string }>();
    const providers = items.map(value => {
      const row = record(value);
      if (row.CHAPTER_CODE !== definition.chapter || !Array.isArray(row.PHONENUMBERS) || row.PHONENUMBERS.length > 50) throw invalid();
      const position = numericIdentity(row.PositionId), employee = numericIdentity(row.EmployeeNumber);
      if (position <= 0 || typeof row.ItemKeyIndex !== "string" || !row.ItemKeyIndex || row.ItemKeyIndex.length > 8_192) throw invalid();
      const reference = "provider-" + createHash("sha256").update(JSON.stringify([category, employee, position])).digest("hex").slice(0, 32);
      if (references.has(reference)) throw invalid();
      const projected = { reference } as DirectoryDoctor;
      for (const key of ["TITEL", "FIRST_NAME", "LAST_NAME", "SERVICE_NAME", "TREAT_AREA_1", "TREAT_AREA_2", "TREAT_AREA_3", "TREAT_AREA_4", "TREAT_AREA_5", "TREAT_AREA_6", "CITY_NAME", "PARTIALLY_ADRESS"] as const) projected[key] = text(row[key]);
      projected.PHONENUMBERS = row.PHONENUMBERS.map(value => { const contact = record(value); return { Title: text(contact.Title), Value: text(contact.Value) }; });
      references.set(reference, { itemKey: row.ItemKeyIndex, position, employee, city: projected.CITY_NAME, service: projected.SERVICE_NAME });
      return projected;
    });
    const output: ProviderSearchResult = { category, field: specialty, selection: { category, field, options: { ...options, page } }, providers, filters: { ...(city ? { city: { city: city.key, label: city.label } } : {}), ...(options.name !== undefined ? { name: options.name } : {}) }, coverage: { page, returned: providers.length, reportedTotalItems, reportedTotalPages, pagingSupported: true } };
    return { result: output, references, requestId: query.RequestId };
  }
  #json(raw: string): Record<string, unknown> {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw invalid(); }
    return record(parsed);
  }
  #searchResponse(raw: string): Record<string, unknown> {
    const result = this.#json(raw);
    if (!Array.isArray(result.Errors)) throw invalid();
    if (result.Success !== true || result.Errors.length !== 0) throw new UpstreamError("DIRECTORY_SEARCH_FAILED");
    if (!Array.isArray(result.Items) || result.Items.length > 100 || count(result.TotalItems) < result.Items.length) throw invalid();
    count(result.NumOfPages);
    return result;
  }
  #result<T>(data: T, operation: string): ReadResult<T> {
    return { data, retrievedAt: new Date().toISOString(), source: { service: "PublicDirectory", operation, completeness: "upstream-response", schemaEvidence: "frontend-field-projection" } };
  }
  async #request(url: string, mime: string, body?: object): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: body ? "POST" : "GET", credentials: "omit", redirect: "manual",
        headers: body ? { Accept: mime, "Content-Type": "application/json" } : { Accept: mime },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new UpstreamError("REQUEST_TIMEOUT");
      if (error instanceof Error && error.name === "AbortError") throw new UpstreamError("REQUEST_ABORTED");
      throw new UpstreamError("DIRECTORY_REQUEST_FAILED");
    }
    if (response.status !== 200) throw new UpstreamError("DIRECTORY_HTTP_ERROR", response.status);
    if ((response.url && response.url !== url) || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== mime || !response.body) throw invalid();
    const bodyStream = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    return readResponseBody(async () => {
      try {
        for (;;) {
          const part = await bodyStream.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_BODY) { await bodyStream.cancel(); throw invalid(); }
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } finally { bodyStream.releaseLock(); }
    }, invalid());
  }
}
