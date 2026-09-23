/**
 * Rows of the test list exactly as the source returns them. Shape observed against a real account on
 * 2026-09-23: 35 rows (30 lab_result, 3 imaging_result, 1 external_test_result, 1 imaging_study), every one
 * carrying the same 28 keys. result_files is populated only for imaging_result and external_test_result and
 * is null for lab_result and imaging_study, which is why the download gate reads that field and not the type.
 */
export interface SourceTestRow {
  category_id: number;
  category_name: string;
  category_original_id: number;
  concealment: string;
  data_type_code: number;
  doc_id: string;
  doc_type_id: number;
  doc_type_name: string;
  execute_date: string;
  executed_by: null;
  executing_institute: string | null;
  file_name: null;
  hash: string;
  is_partial: boolean;
  is_read: boolean;
  is_result_yesterday: boolean;
  member_id: string;
  /** Source sends this as a number while member_id next to it is a string. */
  member_id_code: number;
  procedures: { test_name: string; test_id: string | null }[] | null;
  referrer_name: string | null;
  request_id: string;
  result_date: string;
  result_date_desc: string;
  result_files: { result_file: string }[] | null;
  test_category: string[];
  test_name: string[];
  time_stamp: string;
  type: string;
  [key: string]: unknown;
}
export type SourceTestRowType = "lab_result" | "imaging_result" | "external_test_result" | "imaging_study";
/** Owner the core test fixtures read as; every row must carry it or the reader rejects the whole list. */
export const FIXTURE_MEMBER_ID = 123456789;
const base = (): SourceTestRow => ({
  category_id: 1,
  category_name: "קטגוריה לדוגמה",
  category_original_id: 1,
  concealment: "0",
  data_type_code: 1,
  doc_id: "fixture-document",
  doc_type_id: 1,
  doc_type_name: "מסמך לדוגמה",
  execute_date: "2025-01-01T00:00:00",
  executed_by: null,
  executing_institute: null,
  file_name: null,
  hash: "synthetic%2Fhash%3D%3D",
  is_partial: false,
  is_read: false,
  is_result_yesterday: false,
  member_id: String(FIXTURE_MEMBER_ID),
  member_id_code: 0,
  procedures: null,
  referrer_name: null,
  request_id: "fixture-request",
  result_date: "2025-01-02T00:00:00",
  result_date_desc: "01.01.2025",
  result_files: null,
  test_category: [],
  test_name: ["בדיקה לדוגמה"],
  time_stamp: "synthetic-time",
  type: "lab_result",
});
const byType: Record<SourceTestRowType, Partial<SourceTestRow>> = {
  lab_result: {},
  imaging_result: {
    executing_institute: "מכון דימות לדוגמה",
    procedures: [{ test_name: "דימות לדוגמה", test_id: "fixture-procedure" }],
    result_files: [{ result_file: "synthetic/attachment/path" }],
    test_name: ["דימות לדוגמה"],
  },
  external_test_result: {
    executing_institute: "מכון חיצוני לדוגמה",
    // Source leaves test_id null on this type even though imaging rows fill it.
    procedures: [{ test_name: "בדיקה חיצונית לדוגמה", test_id: null }],
    result_files: [{ result_file: "synthetic/attachment/path" }],
    test_category: ["קטגוריה לדוגמה"],
    test_name: ["בדיקה חיצונית לדוגמה"],
  },
  imaging_study: { referrer_name: "רופא מפנה לדוגמה", test_name: ["בדיקת דימות לדוגמה"] },
};
export const testRow = (type: SourceTestRowType = "lab_result", overrides: Partial<SourceTestRow> = {}): SourceTestRow =>
  ({ ...base(), ...byType[type], type, ...overrides });
