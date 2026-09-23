import { describe, expect, test } from "vitest";
import { projectFollowedLabResults, projectLabComparison, projectLatestLabResults } from "../src/readers/latest-lab-results";

const row = () => ({
  test_id: "fixture-test",
  test_desc: "בדיקה לדוגמה",
  units: "unit",
  message: "",
  message_list: ["שורה מקורית", ""],
  lab_date: "source-date",
  min_lim: 1,
  max_lim: 3,
  result: 2,
  numeric_percentage: 50,
  is_messages: "source-flag",
  is_vitek: true,
  is_follow: false,
  vitek_row: [{ bacterium_name: "חיידק לדוגמה", drugs_and_sensitivity_list: [{ name_of_drug: "תרופה לדוגמה", sensitivity: "S" }] }],
  result_file: null,
  time_stamp: null,
  hash: null,
  private_routing: "omitted",
});

describe("lab comparison frontend projection", () => {
  const comparisonRow = (date: string) => ({ ...row(), lab_date: date, doc_first_name: "שם", doc_last_name: "רופא", is_graph: true });

  test("preserves current and historical rendered rows while hiding report signatures", () => {
    const source = { current_result: comparisonRow("selected-date"), other_results: [comparisonRow("historical-date")], hash: "private-report-hash", timestamp: "private-report-time" };
    const result = projectLabComparison(source, "fixture-test", "selected-date");
    expect(result.current_result.doc_first_name).toBe("שם");
    expect(result.current_result.is_graph).toBe(true);
    expect(result.other_results[0]!.lab_date).toBe("historical-date");
    expect(JSON.stringify(result)).not.toMatch(/private-report/);
  });

  test("binds the response to the selected test and current date", () => {
    const valid = { current_result: comparisonRow("selected-date"), other_results: [comparisonRow("historical-date")], hash: "hash", timestamp: "time" };
    expect(() => projectLabComparison(valid, "other-test", "selected-date")).toThrow();
    expect(() => projectLabComparison(valid, "fixture-test", "other-date")).toThrow();
    expect(() => projectLabComparison({ ...valid, other_results: [{ ...comparisonRow("old"), test_id: "other-test" }] }, "fixture-test", "selected-date")).toThrow();
    expect(() => projectLabComparison({ ...valid, hash: null }, "fixture-test", "selected-date")).toThrow();
  });
});

describe("followed lab result frontend projection", () => {
  test("preserves the read-only watch list and available-test labels without report signatures", () => {
    const source = { followed_counter: 1, followed_tests: [row()], options: [{ test_id: 123, test_desc: "בדיקה זמינה", is_follow: false }], timestamp: "private-time", hash: "private-hash" };
    const result = projectFollowedLabResults(source);
    expect(result.followed_counter).toBe(1);
    expect(result.followed_tests[0]!.test_desc).toBe("בדיקה לדוגמה");
    expect(result.options).toEqual([{ test_id: 123, test_desc: "בדיקה זמינה", is_follow: false }]);
    expect(JSON.stringify(result)).not.toMatch(/private-time|private-hash/);
  });

  test("rejects malformed counters and option identities", () => {
    const base = { followed_counter: 0, followed_tests: [], options: [], timestamp: "time", hash: "hash" };
    for (const source of [{ ...base, followed_counter: -1 }, { ...base, options: [{ test_id: {}, test_desc: "x", is_follow: false }] }, { ...base, options: [{ test_id: "x", test_desc: "x", is_follow: "false" }] }]) {
      expect(() => projectFollowedLabResults(source)).toThrow();
    }
  });
});

describe("latest lab result frontend projection", () => {
  test("preserves rendered scalar, long-text and Vitek content", () => {
    const result = projectLatestLabResults([{ group_name: "קבוצה לדוגמה", group_values: [row()] }]);
    expect(result).toEqual([{ group_name: "קבוצה לדוגמה", group_values: [{
      test_id: "fixture-test", test_desc: "בדיקה לדוגמה", units: "unit", message: "", message_list: ["שורה מקורית", ""], lab_date: "source-date",
      min_lim: 1, max_lim: 3, result: 2, numeric_percentage: 50, is_messages: "source-flag", is_vitek: true, is_follow: false,
      vitek_row: [{ bacterium_name: "חיידק לדוגמה", drugs_and_sensitivity_list: [{ name_of_drug: "תרופה לדוגמה", sensitivity: "S" }] }], has_result_file: false,
    }] }]);
    expect(JSON.stringify(result)).not.toContain("private_routing");
  });

  test("reports attachment eligibility without exposing private routing or signatures", () => {
    const attached = { ...row(), result_file: "private-path", time_stamp: "private-time", hash: "private-hash" };
    const result = projectLatestLabResults([{ group_name: "group", group_values: [attached] }]);
    expect(result[0]!.group_values[0]!.has_result_file).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-path|private-time|private-hash/);
  });

  test("rejects malformed numeric, nested and attachment shapes", () => {
    const invalid = [
      { ...row(), numeric_percentage: 1.5 },
      { ...row(), result: "2" },
      { ...row(), is_messages: "" },
      { ...row(), message_list: [7] },
      { ...row(), vitek_row: [{ bacterium_name: "x", drugs_and_sensitivity_list: [{ name_of_drug: "x" }] }] },
      { ...row(), result_file: "path", time_stamp: null, hash: "hash" },
      { ...row(), result_file: null, time_stamp: "orphan", hash: null },
    ];
    for (const value of invalid) expect(() => projectLatestLabResults([{ group_name: "group", group_values: [value] }])).toThrow();
  });
});
