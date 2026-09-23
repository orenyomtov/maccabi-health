import { load } from "cheerio/slim";
import { decodeHTML } from "entities";
import { createHash } from "node:crypto";
import { LegacyContentError } from "./legacy";

export interface NursingInsuranceCatalog {
  reports: { period: string; productionDate: string; viewLabel: string; reference?: string }[];
  pagination: { returned: number; reportedResultCount: number; totalPages: number; currentPage: 1 };
}

const ROOT = ".dataGrid > .more_info > .yearly_table > .maintable";
const fail = (): never => { throw new LegacyContentError(); };
const normalized = (value: string): string => decodeHTML(value).replace(/\s+/gu, " ").trim();

function parse(html: string) {
  if (!html.trim() || Buffer.byteLength(html) > 1024 * 1024) fail();
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: false } }, false);
  const hidden = (element: Parameters<typeof $>[0]): boolean => {
    const node = $(element);
    return node.attr("hidden") !== undefined || node.attr("aria-hidden") === "true" ||
      /(?:^|\s)(?:hidden|hide|d-none)(?:\s|$)/i.test(node.attr("class") ?? "") ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.attr("style") ?? "");
  };
  const root = $(ROOT);
  if (root.length !== 1 || root.toArray().some(hidden) || root.parents().toArray().some(hidden)) fail();
  const number = (id: string): number => {
    const nodes = $(`input#${id}`), value = nodes.attr("value") ?? "";
    if (nodes.length !== 1 || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail();
    return Number(value);
  };
  const reportedResultCount = number("GridNumOfResultsHidden"), totalPages = number("GridTotalPagesHidden");
  $("script, style, input, iframe, object, form").remove();
  $("*").filter((_, element) => hidden(element)).remove();
  if (root.children("ul.headinggroup").children("li.headinggroup").children("span").length !== 3) fail();
  const rows = root.children("ul.rowgroup").children("li").toArray();
  if (rows.length > 1_000 || reportedResultCount < rows.length || (reportedResultCount > 0 && !rows.length) || (rows.length > 0 && totalPages < 1)) fail();
  const reports = rows.map(element => {
    const cells = $(element).children("span");
    if (cells.length !== 3) fail();
    const values = cells.toArray().map(cell => normalized($(cell).text()));
    if (values.some(value => !value || value.length > 4096)) fail();
    return { period: values[0]!, productionDate: values[1]!, viewLabel: values[2]! };
  });
  const catalog: NursingInsuranceCatalog = { reports, pagination: { returned: reports.length, reportedResultCount, totalPages, currentPage: 1 } };
  if (Buffer.byteLength(JSON.stringify(catalog)) > 128 * 1024) fail();
  return { $, rows, catalog };
}

/** Visible first-page annual nursing-insurance catalog. It does not assert an individual insured-person scope. */
export function parseNursingInsuranceRows(html: string): NursingInsuranceCatalog {
  return parse(html).catalog;
}

/** Private access arguments from the exact first-party row action; never include them in public read results. */
export function parseNursingInsuranceDocuments(html: string, reports: NursingInsuranceCatalog["reports"]): { reference: string; token: string; reportType: string }[] {
  const { $, rows, catalog } = parse(html);
  if (reports.length !== catalog.reports.length || reports.some((r, i) => r.period !== catalog.reports[i]!.period || r.productionDate !== catalog.reports[i]!.productionDate || r.viewLabel !== catalog.reports[i]!.viewLabel)) fail();
  const seen = new Set<string>();
  return rows.map((element, index) => {
    const anchors = $(element).children("span").eq(2).find("a[onclick]");
    if (anchors.length !== 1) fail();
    const action = decodeHTML(anchors.attr("onclick") ?? "");
    const match = /^\s*LTCReport\.OpenReportPdf\('([^']*)',\s*'([^']*)'\);?\s*$/.exec(action);
    if (!match) fail();
    const token = match![1]!, reportType = match![2]!;
    for (const value of [token, reportType]) {
      if (!value || value.length > 8192 || /['\\&#?=\u0000-\u0020\u007f]/.test(value) || /%(?![0-9a-fA-F]{2})/.test(value)) fail();
    }
    const report = reports[index]!;
    const reference = createHash("sha256").update(JSON.stringify(["nursing-insurance", report.period, report.productionDate, reportType])).digest("hex");
    if (seen.has(reference)) fail();
    seen.add(reference);
    return { reference, token, reportType };
  });
}
