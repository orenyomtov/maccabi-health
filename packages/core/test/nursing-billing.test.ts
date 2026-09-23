import { describe, expect, test } from "vitest";
import { parseNursingInsuranceRows, parseNursingInsuranceDocuments } from "../src/readers/nursing-billing";
import { LegacyContentError } from "../src/readers/legacy";

function row(period = "Synthetic annual period", token = "synthetic-token", type = "synthetic-type") {
  return `<li><span>${period}</span><span>Synthetic production date</span><span><a onclick="LTCReport.OpenReportPdf('` + token + `', '` + type + `');">View report</a></span></li>`;
}
function page(rows = row(), count = 1, pages = 1) {
  return `<div class="dataGrid"><div class="more_info showinfobox"><div class="yearly_table"><div class="maintable"><ul class="headinggroup"><li class="headinggroup"><span>Period</span><span>Production date</span><span>Reports</span></li></ul><ul class="rowgroup">${rows}</ul></div></div></div></div><div id="moreResults"></div><input id="GridNumOfResultsHidden" value="${count}"><input id="GridTotalPagesHidden" value="${pages}">`;
}

describe("annual nursing-insurance billing fragment", () => {
  test("returns visible period text and first-page coverage, while keeping archive arguments separate", () => {
    const html = page(row("Synthetic &amp; annual period"));
    const catalog = parseNursingInsuranceRows(html);
    expect(catalog).toEqual({ reports: [{ period: "Synthetic & annual period", productionDate: "Synthetic production date", viewLabel: "View report" }], pagination: { returned: 1, reportedResultCount: 1, totalPages: 1, currentPage: 1 } });
    expect(JSON.stringify(catalog)).not.toContain("synthetic-token");
    const docs = parseNursingInsuranceDocuments(html, catalog.reports);
    expect(docs).toEqual([{ reference: expect.stringMatching(/^[a-f0-9]{64}$/), token: "synthetic-token", reportType: "synthetic-type" }]);
    const rotated = page(row("Synthetic &amp; annual period", "another-token"));
    expect(parseNursingInsuranceDocuments(rotated, parseNursingInsuranceRows(rotated).reports)[0]!.reference).toBe(docs[0]!.reference);
  });

  test("does not pretend a bounded first page is the full catalog", () => {
    expect(parseNursingInsuranceRows(page(row(), 3, 2)).pagination).toEqual({ returned: 1, reportedResultCount: 3, totalPages: 2, currentPage: 1 });
    expect(parseNursingInsuranceRows(page("", 0, 0)).reports).toEqual([]);
    expect(() => parseNursingInsuranceRows(page("", 1, 1))).toThrow(LegacyContentError);
  });

  test("rejects missing, duplicate, hidden, malformed, and oversized catalog structures", () => {
    const valid = page();
    for (const html of ["<html>Sign in</html>", valid + valid, valid.replace('class="yearly_table"', 'class="quaterly_table"'), valid.replace('class="dataGrid"', 'class="dataGrid Hidden"'), valid.replace('class="yearly_table"', 'class="yearly_table" style="display:none"'), valid.replace("<span>Production date</span>", ""), valid.replace("<span>Synthetic production date</span>", ""), valid.replace('value="1"', 'value="unknown"'), valid.replace('value="1"', 'value="0"'), " ".repeat(1024 * 1024) + valid]) {
      expect(() => parseNursingInsuranceRows(html)).toThrow(LegacyContentError);
    }
  });

  test("removes scripts, controls, and hidden content without changing visible clinical text", () => {
    const html = page(row("Original text <script>secret()</script><input value='secret'><span hidden>secret</span><em> preserved</em>"));
    expect(parseNursingInsuranceRows(html).reports[0]!.period).toBe("Original text preserved");
  });

  test("accepts entity-escaped exact handlers and rejects wrong or injected actions", () => {
    const escaped = page().replaceAll("'", "&#39;");
    expect(parseNursingInsuranceDocuments(escaped, parseNursingInsuranceRows(escaped).reports)).toHaveLength(1);
    for (const html of [page().replace("LTCReport", "QuarterlyReport"), page().replace(";\">", "; anotherCall();\">"), page(row("Period", "unsafe&query")), page(row("Period", "bad%zz")), page(row("Period", "")), page(row() + row(), 2)]) {
      expect(() => parseNursingInsuranceDocuments(html, parseNursingInsuranceRows(html).reports)).toThrow(LegacyContentError);
    }
    expect(() => parseNursingInsuranceDocuments(page(), [{ period: "Other period", productionDate: "Synthetic production date", viewLabel: "View report" }])).toThrow(LegacyContentError);
  });
});
