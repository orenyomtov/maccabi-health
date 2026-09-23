import { describe, expect, test } from "vitest";
import { LegacyContentError, parseLegacyRecommendations, parseLegacySelectedSummary } from "../src/readers/legacy";

// Manually authored synthetic structures. No captured text, identifiers, URLs or medical values.
const grid = (columns: string[], rows: string[][]) => `<ul class="appList"><li><table><thead><tr>${columns.map(c => `<th>${c}</th>`).join("")}</tr></thead></table></li>${rows.map(row => `<li><table><tbody><tr>${row.map(c => `<td>${c}</td>`).join("")}</tr></tbody></table></li>`).join("")}</ul>`;
const recommendations = (extra = "") => `<form><div class="personalMenu">PRIVATE IDENTITY</div><div class="recommendationsTitle"><h2>Recommendations</h2></div><div class="personal-recommendations-details"><input value="SECRET"><div class="medicalReInfo"><p>Context &amp; limitations</p></div><div class="medicalReSubject"><a>Group</a><div class="medicalReSubjectInner">${grid(["Range", "Recommendation"], [["", `<p>Original clinical wording: &ge; 3 &mu;g.</p>${extra}<ul class="actionButtons"><li>SUBMIT SECRET</li></ul>`]])}</div></div><div class="commentBlock">Source limitation</div><div class="termsOfUse">Not clinical content</div></div></form>`;
const summary = () => `<form><div class="personalMenu">PRIVATE IDENTITY</div><div id="summery"><div class="medicalFileDesc">This is a selected summary.<br>It is not the complete record.</div><div id="drugs"><div class="summeryInnerTitle"><h3>Recent medications</h3><p>Source period</p></div>${grid(["Medication", "Date"], [[`<a href="https://example.invalid/private?token=SECRET">Example drug</a>`, "Synthetic date"]])}</div><div id="labResults"><div class="summeryInnerTitle"><div class="table-cell"><h3>Recent tests</h3>Source period</div></div>${grid(["Test", "Date", "Description", "Result"], [["Example", "Synthetic date", "Original text", "0"]])}</div><div id="englishNameUpdate"><input value="PRIVATE IDENTITY"></div><div class="baseMedicalFile">Request export</div></div></form>`;

describe("observed legacy projections", () => {
  test("recommendations retain source labels/prose and empty cells, omit hidden controls and metadata", () => {
    const out = parseLegacyRecommendations(recommendations(`<script>SECRET</script><span hidden>SECRET</span><span style="display: none !important">SECRET</span><span aria-hidden="true">SECRET</span><textarea>SECRET</textarea><span class="Hidden">SECRET</span><!-- SECRET -->`));
    expect(out.sections[0]!.table).toEqual({ columns: ["Range", "Recommendation"], rows: [["", "Original clinical wording: ≥ 3 μg."]] });
    expect(out.introduction).toBe("Context & limitations");
    expect(out.closingNote).toBe("Source limitation");
    expect(JSON.stringify(out)).not.toMatch(/SECRET|PRIVATE|SUBMIT|Not clinical/);
  });
  test("selected summary preserves visible linked labels, never link targets or request controls", () => {
    const out = parseLegacySelectedSummary(summary());
    expect(out.medications.table.rows).toEqual([["Example drug", "Synthetic date"]]);
    expect(out.laboratory.table.rows[0]).toEqual(["Example", "Synthetic date", "Original text", "0"]);
    expect(out.description).toBe("This is a selected summary. It is not the complete record.");
    expect(JSON.stringify(out)).not.toMatch(/https:|SECRET|PRIVATE|Request export/);
  });
  test("login/error/shell documents and duplicated content markers fail closed", () => {
    for (const html of ["", "<h1>Login</h1><input type=password>", "<div id=app></div>", "<h1>Temporary error</h1>"]) {
      expect(() => parseLegacyRecommendations(html)).toThrow(LegacyContentError);
      expect(() => parseLegacySelectedSummary(html)).toThrow(LegacyContentError);
    }
    expect(() => parseLegacyRecommendations(recommendations() + recommendations())).toThrow(LegacyContentError);
    expect(() => parseLegacySelectedSummary(summary() + summary())).toThrow(LegacyContentError);
  });
  test("missing or malformed table content never becomes an empty successful result", () => {
    expect(() => parseLegacyRecommendations(recommendations().replace("<td></td>", ""))).toThrow(LegacyContentError);
    expect(() => parseLegacySelectedSummary(summary().replace(/<tbody>[\s\S]*?<\/tbody>/g, ""))).toThrow(LegacyContentError);
    expect(() => parseLegacySelectedSummary(summary().replace('id="drugs"', 'id="unknown"'))).toThrow(LegacyContentError);
  });
  test("hidden operation root and size limits fail safely", () => {
    expect(() => parseLegacyRecommendations(recommendations().replace('class="personal-recommendations-details"', 'class="personal-recommendations-details" hidden'))).toThrow(LegacyContentError);
    expect(() => parseLegacyRecommendations(" ".repeat(1024 * 1024 + 1))).toThrow(LegacyContentError);
    expect(() => parseLegacyRecommendations(recommendations("x".repeat(128 * 1024)))).toThrow(LegacyContentError);
  });
});

test("legacy owner proof requires the unique server-rendered current-patient header marker", async () => {
  const { assertLegacyPageOwner } = await import("../src/readers/legacy");
  const id = "ctl00_ctl00_wcSiteHeaderLobby1_wcSiteHeaderCurrentPatient_wcSiteHeaderChildrenList_lblCustomerIDNumber";
  const page = `<header><div style="display:none"><span id="${id}">000000123</span></div></header>`;
  expect(() => assertLegacyPageOwner(page, 123)).not.toThrow();
  expect(() => assertLegacyPageOwner(page, 124)).toThrow(LegacyContentError);
  expect(() => assertLegacyPageOwner(page + page, 123)).toThrow(LegacyContentError);
  expect(() => assertLegacyPageOwner(`<script>123</script><input value="123">`, 123)).toThrow(LegacyContentError);
  expect(() => assertLegacyPageOwner(page.replace(/header/g, "section"), 123)).toThrow(LegacyContentError);
});

test("hospital settings use fixed JSON and application root without evaluating code", async () => {
  const { parseLegacyHospitalSettings } = await import("../src/readers/legacy");
  const page = `<div id="mailingsFromHospitalsController"></div><script>jqe.appRoot = '/online'; var pageSettings = {"YearsBack":"3","Title":"Synthetic ; title"};</script>`;
  expect(parseLegacyHospitalSettings(page)).toEqual({ yearsBack: 3 });
  for (const html of [page + page, page.replace('"3"', "sideEffect()"), page.replace("/online", "/other"), page.replace('"3"', '"0"'), page.replace('"3"', '"100000"'), page.replace("mailingsFromHospitalsController", "other")]) expect(() => parseLegacyHospitalSettings(html)).toThrow(LegacyContentError);
});
