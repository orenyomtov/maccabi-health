import { load } from "cheerio/slim";
import { decodeHTML } from "entities";
import { createHash } from "node:crypto";
import { LegacyContentError } from "./legacy";

export interface BillingPeriod { value: string; label: string }
export interface QuarterlyBillingCatalog {
  availablePeriods: BillingPeriod[];
  selectedPeriod: BillingPeriod;
  reports: { period: string; productionDate: string; viewLabel: string; reference?: string }[];
  pagination: { returned: number; reportedResultCount: number; totalPages: number; currentPage: 1 };
}
const fail = (): never => { throw new LegacyContentError(); };
const text = (raw: string): string => decodeHTML(raw).replace(/\s+/gu, " ").trim();
function bound(html: string): void { if (!html.trim() || Buffer.byteLength(html) > 1024 * 1024) fail(); }

/** Fresh owner-bound page options only. No evaluation of scripts or PDF access arguments. */
export function parseBillingPeriods(html: string): { availablePeriods: BillingPeriod[]; defaultPeriod: BillingPeriod } {
  bound(html);
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: false } }, false);
  const gate = $("#isUnderConstruction");
  const gateCount = gate.length, blocked = gate.attr("value") === "1";
  const selects = $("select#PeriodSelectDropDownList").length;
  const options = $("select#PeriodSelectDropDownList > option").toArray().map(element => {
    const node = $(element), value = node.attr("value");
    if (!value || !/^\d{1,4}$/.test(value)) fail();
    return { value: value!, label: node.text(), selected: node.attr("selected") !== undefined };
  });
  const scripts = $("script").toArray().map(element => $(element).text());
  const roots = scripts.flatMap(s => [...s.matchAll(/\bjqe\.appRoot\s*=\s*(["'])([^"']*)\1\s*;/g)]);
  if (selects !== 1 || gateCount !== 1 || blocked || roots.length !== 1 || roots[0]![2] !== "/online" || !options.length || options.length > 100 || new Set(options.map(o => o.value)).size !== options.length) fail();
  for (const option of options) { option.label = text(option.label); if (!option.label) fail(); }
  const selected = options.filter(o => o.selected);
  if (selected.length > 1) fail();
  const defaultOption = selected[0] ?? options[0]!;
  return { availablePeriods: options.map(({value,label}) => ({value,label})), defaultPeriod: { value: defaultOption.value, label: defaultOption.label } };
}

/** Captured quarterly catalog fragment: three visible cells, first server page only. */
export function parseQuarterlyBillingRows(html: string): Pick<QuarterlyBillingCatalog, "reports" | "pagination"> {
  bound(html);
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: false } }, false);
  $("script, style, input:not([id=GridNumOfResultsHidden]):not([id=GridTotalPagesHidden]), iframe, object").remove();
  const root = ".dataGrid > .quaterly_table > .maintable";
  const roots = $(root).length, headerCells = $(`${root} > ul.headinggroup > li.headinggroup > span`).length;
  const rows = $(`${root} > ul.rowgroup > li`).toArray().map(element => $(element).children("span").toArray().map(cell => $(cell).text()));
  const counts: Record<string, string[]> = {};
  $("input#GridNumOfResultsHidden, input#GridTotalPagesHidden").each((_, element) => {
    const node = $(element), id = node.attr("id")!;
    (counts[id] ??= []).push(node.attr("value") ?? "");
  });
  const number = (id: string): number => {
    const values = counts[id];
    if (values?.length !== 1 || !/^\d+$/.test(values[0]!)) fail();
    const value = Number(values![0]); if (!Number.isSafeInteger(value)) fail(); return value;
  };
  const reportedResultCount = number("GridNumOfResultsHidden"), totalPages = number("GridTotalPagesHidden");
  if (roots !== 1 || headerCells !== 3 || rows.length > 1000 || rows.some(r => r.length !== 3) || reportedResultCount < rows.length || (reportedResultCount > 0 && rows.length === 0) || (rows.length > 0 && totalPages < 1)) fail();
  const reports = rows.map(r => { const fields = r.map(text); if (fields.some(f => !f)) fail(); return { period: fields[0]!, productionDate: fields[1]!, viewLabel: fields[2]! }; });
  const result = { reports, pagination: { returned: reports.length, reportedResultCount, totalPages, currentPage: 1 as const } };
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) fail();
  return result;
}

/** Private archive arguments from the exact observed row action; never return them to consumers. */
export function parseQuarterlyBillingDocuments(html: string, reports: QuarterlyBillingCatalog["reports"]): { reference: string; token: string; reportType: string }[] {
  bound(html);
  const rowSelector = ".dataGrid > .quaterly_table > .maintable > ul.rowgroup > li";
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: false } }, false);
  const actions = $(rowSelector).toArray().map(element => $(element).children("span").eq(2).find("a[onclick]").toArray().map(anchor => decodeHTML($(anchor).attr("onclick") ?? "")));
  if (actions.length !== reports.length || actions.some(a => a.length !== 1)) fail();
  const references = new Set<string>();
  return actions.map((action, i) => {
    const match = /^\s*QuarterlyReport\.OpenReportPdf\('([^']*)',\s*'([^']*)'\);?\s*$/.exec(action[0]!);
    if (!match) fail();
    const token = match![1]!, reportType = match![2]!;
    // Source embeds these fields in a single-quoted body and directly in the popup query.
    for (const value of [token, reportType]) if (!value || value.length > 8192 || /['\\&#?=\u0000-\u0020\u007f]/.test(value) || /%(?![0-9a-fA-F]{2})/.test(value)) fail();
    const report = reports[i]!;
    const reference = createHash("sha256").update(JSON.stringify([report.period, report.productionDate, reportType])).digest("hex");
    if (references.has(reference)) fail();
    references.add(reference);
    return { reference, token, reportType };
  });
}
