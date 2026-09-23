export interface LatestLabVitekDrug {
  name_of_drug: string;
  sensitivity: string;
}

export interface LatestLabVitekRow {
  bacterium_name: string;
  drugs_and_sensitivity_list: LatestLabVitekDrug[];
}

export interface LatestLabResult {
  test_id: string;
  test_desc: string;
  units: string;
  message: string;
  message_list: string[];
  lab_date: string;
  min_lim: number;
  max_lim: number;
  result: number;
  numeric_percentage: number;
  is_messages: string;
  is_vitek: boolean;
  is_follow: boolean;
  vitek_row: LatestLabVitekRow[];
  has_result_file: boolean;
}

export interface LatestLabResultGroup {
  group_name: string;
  group_values: LatestLabResult[];
}

export interface LabComparisonResult extends LatestLabResult {
  doc_first_name: string;
  doc_last_name: string;
  is_graph: boolean;
}

export interface LabComparison {
  current_result: LabComparisonResult;
  other_results: LabComparisonResult[];
}

export interface FollowedLabOption {
  test_id: string | number;
  test_desc: string;
  is_follow: boolean;
}

export interface FollowedLabResults {
  followed_counter: number;
  followed_tests: LatestLabResult[];
  options: FollowedLabOption[];
}

export class LatestLabResultContentError extends Error {
  constructor() {
    super("Maccabi latest lab results do not match the official frontend projection");
    this.name = "LatestLabResultContentError";
  }
}

const fail = (): never => { throw new LatestLabResultContentError(); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const text = (value: unknown, empty = false): string => typeof value === "string" && (empty || value.length > 0) ? value : fail();
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : fail();
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const array = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value as unknown[] : fail();

const projectResult = (rawResult: unknown): LatestLabResult => {
  const result = record(rawResult);
  const result_file = result.result_file;
  const has_result_file = result_file !== undefined && result_file !== null;
  if (has_result_file) {
    text(result_file);
    text(result.time_stamp);
    text(result.hash);
  } else if (result.time_stamp !== undefined && result.time_stamp !== null || result.hash !== undefined && result.hash !== null) fail();

  const message_list = array(result.message_list, 1000).map(item => text(item, true));
  const vitek_row = array(result.vitek_row, 1000).map(rawVitek => {
    const vitek = record(rawVitek);
    const drugs_and_sensitivity_list = array(vitek.drugs_and_sensitivity_list, 1000).map(rawDrug => {
      const drug = record(rawDrug);
      return { name_of_drug: text(drug.name_of_drug, true), sensitivity: text(drug.sensitivity, true) };
    });
    return { bacterium_name: text(vitek.bacterium_name, true), drugs_and_sensitivity_list };
  });

  const numeric_percentage = number(result.numeric_percentage);
  if (!Number.isSafeInteger(numeric_percentage)) fail();
  return {
    test_id: text(result.test_id),
    test_desc: text(result.test_desc),
    units: text(result.units, true),
    message: text(result.message, true),
    message_list,
    lab_date: text(result.lab_date),
    min_lim: number(result.min_lim),
    max_lim: number(result.max_lim),
    result: number(result.result),
    numeric_percentage,
    is_messages: text(result.is_messages),
    is_vitek: bool(result.is_vitek),
    is_follow: bool(result.is_follow),
    vitek_row,
    has_result_file,
  };
};

/** Fields rendered by the official latest-results groups, rows, long-text and Vitek views. */
export function projectLatestLabResults(value: unknown): LatestLabResultGroup[] {
  const groups = array(value, 100).map(rawGroup => {
    const group = record(rawGroup);
    const group_name = text(group.group_name);
    const group_values = array(group.group_values, 1000).map(projectResult);
    return { group_name, group_values };
  });
  if (Buffer.byteLength(JSON.stringify(groups)) > 2 * 1024 * 1024) fail();
  return groups;
}

/** Owner-selected comparison rows. Top-level report signatures remain private for the PDF getter. */
export function projectLabComparison(value: unknown, selectedTestId: string, selectedDate: string): LabComparison {
  if (!selectedTestId || !selectedDate) fail();
  const source = record(value);
  text(source.hash); text(source.timestamp);
  const projectComparisonResult = (raw: unknown): LabComparisonResult => {
    const row = record(raw);
    const projected = projectResult(row);
    if (projected.test_id !== selectedTestId) fail();
    return { ...projected, doc_first_name: text(row.doc_first_name, true), doc_last_name: text(row.doc_last_name, true), is_graph: bool(row.is_graph) };
  };
  const current_result = projectComparisonResult(source.current_result);
  if (current_result.lab_date !== selectedDate) fail();
  const other_results = array(source.other_results, 1000).map(projectComparisonResult);
  const projected = { current_result, other_results };
  if (Buffer.byteLength(JSON.stringify(projected)) > 2 * 1024 * 1024) fail();
  return projected;
}

/** Read-only watch-list content. Star toggles are a separate PUT and are intentionally absent. */
export function projectFollowedLabResults(value: unknown): FollowedLabResults {
  const source = record(value);
  const followed_counter = number(source.followed_counter);
  if (!Number.isSafeInteger(followed_counter) || followed_counter < 0) fail();
  text(source.timestamp); text(source.hash);
  const followed_tests = array(source.followed_tests, 1000).map(projectResult);
  const options = array(source.options, 10000).map(rawOption => {
    const option = record(rawOption);
    const test_id = option.test_id;
    if (!(typeof test_id === "string" && test_id.length > 0) && !(typeof test_id === "number" && Number.isSafeInteger(test_id))) fail();
    return { test_id: test_id as string | number, test_desc: text(option.test_desc), is_follow: bool(option.is_follow) };
  });
  const projected = { followed_counter, followed_tests, options };
  if (Buffer.byteLength(JSON.stringify(projected)) > 2 * 1024 * 1024) fail();
  return projected;
}
