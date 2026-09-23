import { load } from "cheerio/slim";
import { decodeHTML } from "entities";

/** Pure projections of observed legacy HTML. Callers must establish session/owner and response origin first. */
export class LegacyContentError extends Error {
  constructor() { super("Maccabi legacy content does not match the observed page structure"); this.name = "LegacyContentError"; }
}
export interface LegacyTable { columns: string[]; rows: string[][] }
export interface LegacyRecommendations { introduction: string; sections: { title: string; table: LegacyTable }[]; closingNote: string }
export interface LegacySelectedSummary {
  description: string;
  medications: { title: string; context: string; table: LegacyTable };
  laboratory: { title: string; context: string; table: LegacyTable };
}
const fail = (): never => { throw new LegacyContentError(); };
function normalized(raw: string): string { return decodeHTML(raw).replace(/\s+/gu, " ").trim(); }
function clean(html: string): string {
  if (Buffer.byteLength(html) > 1024 * 1024 || !html.trim()) fail();
  // Remove controls and hidden/non-content branches before collecting text. Form ancestors are
  // retained: these ASP.NET pages wrap their visible read content in a form.
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: false } }, false);
  $("script, style, noscript, template, input, textarea, select, button, meta, link, iframe, object, .aspNetHidden, .actionButtons, .tooltipR, .termsOfUse").remove();
  $("*").each((_, element) => {
    const node = $(element);
    if (node.attr("hidden") !== undefined || node.attr("aria-hidden") === "true" || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(node.attr("style") ?? "") || /(?:^|\s)(?:hide|hidden)(?:\s|$)/i.test(node.attr("class") ?? "")) node.remove();
  });
  $("br").replaceWith(" ");
  $("p, div, li").prepend(" ").append(" ");
  return $.html();
}
function values(html: string, selector: string, raw = false): string[] {
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: false } }, false);
  const values = $(selector).toArray().map(element => $(element).text());
  return raw ? values : values.map(normalized);
}

function one(html: string, selector: string, allowEmpty = false): string {
  const found = values(html, selector);
  if (found.length !== 1 || (!allowEmpty && !found[0])) fail();
  return found[0]!;
}
function count(html: string, selector: string): number { return load(html, { xml: { xmlMode: false, decodeEntities: false } }, false)(selector).length; }
function table(html: string, selector: string, width: number): LegacyTable {
  const columns = values(html, `${selector} thead th`);
  const cells = values(html, `${selector} tbody td`);
  const rows = count(html, `${selector} tbody tr`);
  if (columns.length !== width || columns.some(x => !x) || rows < 1 || rows > 1000 || cells.length !== rows * width) fail();
  // Require every row to have the observed width, not just the aggregate cell count.
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: false } }, false);
  const widths = $(`${selector} tbody tr`).toArray().map(element => $(element).find("td").length);
  if (widths.some(n => n !== width)) fail();
  return { columns, rows: Array.from({ length: rows }, (_, i) => cells.slice(i * width, (i + 1) * width)) };
}
function bounded<T>(data: T): T { if (Buffer.byteLength(JSON.stringify(data)) > 128 * 1024) fail(); return data; }

export function parseLegacyRecommendations(input: string): LegacyRecommendations {
  const html = clean(input); const root = ".personal-recommendations-details";
  one(html, ".recommendationsTitle h2");
  if (count(html, root) !== 1 || count(html, `${root} .medicalReSubject`) !== 1) fail();
  // Only the single-section shape was captured. Additional section layouts need explicit evidence.
  return bounded({ introduction: one(html, `${root} .medicalReInfo`), sections: [{ title: one(html, `${root} .medicalReSubject > a`), table: table(html, `${root} .medicalReSubjectInner .appList`, 2) }], closingNote: one(html, `${root} .commentBlock`) });
}

export function parseLegacySelectedSummary(input: string): LegacySelectedSummary {
  const html = clean(input); const root = "#summery";
  if (count(html, root) !== 1 || count(html, `${root} #drugs`) !== 1 || count(html, `${root} #labResults`) !== 1) fail();
  return bounded({
    description: one(html, `${root} .medicalFileDesc`),
    medications: { title: one(html, `${root} #drugs h3`), context: one(html, `${root} #drugs .summeryInnerTitle p`), table: table(html, `${root} #drugs .appList`, 2) },
    laboratory: { title: one(html, `${root} #labResults h3`), context: one(html, `${root} #labResults .summeryInnerTitle .table-cell`), table: table(html, `${root} #labResults .appList`, 4) },
  });
}

/** Exact server-rendered current-patient header marker, matched to modern bootstrap in S13.
 * Never return its value. Matching HTML elsewhere (scripts/forms/attributes) is not owner proof.
 */
export function assertLegacyPageOwner(input: string, expectedMemberId: number): void {
  if (!Number.isSafeInteger(expectedMemberId) || expectedMemberId < 0) fail();
  if (Buffer.byteLength(input) > 1024 * 1024) fail();
  // The header menu is initially collapsed with display:none. Identity binding reads only
  // this named span, independently of the visible clinical projection.
  const selector = "span#ctl00_ctl00_wcSiteHeaderLobby1_wcSiteHeaderCurrentPatient_wcSiteHeaderChildrenList_lblCustomerIDNumber";
  if (count(input, selector) !== 1) fail();
  const marker = one(input, `header ${selector}`);
  if (!/^\d{1,9}$/.test(marker) || Number(marker) !== expectedMemberId) fail();
}

/** Source-backed hospital page configuration only; no evaluation or dynamic URL return. */
export function parseLegacyHospitalSettings(input: string): { yearsBack: number } {
  if (Buffer.byteLength(input) > 1024 * 1024 || count(input, "#mailingsFromHospitalsController") !== 1) fail();
  const scripts = values(input, "script", true);
  const settings = scripts.flatMap(script => [...script.matchAll(/\bvar\s+pageSettings\s*=\s*(\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})\s*;/g)]);
  const roots = scripts.flatMap(script => [...script.matchAll(/\bjqe\.appRoot\s*=\s*(["'])([^"']*)\1\s*;/g)]);
  if (settings.length !== 1 || roots.length !== 1 || roots[0]![2] !== "/online") fail();
  let data: unknown;
  try { data = JSON.parse(settings[0]![1]!); } catch { fail(); }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail();
  const years = (data as Record<string, unknown>).YearsBack;
  if (typeof years !== "string" || !/^[1-9]\d?$/.test(years)) fail();
  return { yearsBack: Number(years) };
}
