import { describe, expect, test } from "vitest";
import { projectGeneralMailings } from "../src/readers/general-mailings";

const common = { item_date: "source-date", original_item_date: "source-original-date" };

describe("general mailings frontend projection", () => {
  test("projects informational, requested-record and tutorial branches without routing data", () => {
    const result = projectGeneralMailings([
      { ...common, letter_type: 1, letter_desc: "הודעה מקורית", reference_id: "private-ref", name_document: "private-name", timestamp: "private-time", hash: "private-hash" },
      { ...common, letter_type: 2, status: 1, link: "private-path", timestamp: "private-time", hash: "private-hash" },
      { ...common, letter_type: 2, status: 0 },
      { ...common, letter_type: 3, service_type_text: "שירות מקורי", practitioner_name: "מטפל לדוגמה", tutorials: [
        { tutorial_type: "pdf", display_text: "מסמך", url: "private-url", timestamp: "private-time", hash: "private-hash" },
        { tutorial_type: "webpage", display_text: "עמוד", url: "https://example.invalid/information" },
        { tutorial_type: "video", display_text: "סרטון", url: "https://example.invalid/video" },
      ] },
    ]);
    expect(result).toEqual([
      { ...common, letter_type: 1, letter_desc: "הודעה מקורית", has_document: true },
      { ...common, letter_type: 2, status: 1, has_document: true },
      { ...common, letter_type: 2, status: 0, has_document: false },
      { ...common, letter_type: 3, service_type_text: "שירות מקורי", practitioner_name: "מטפל לדוגמה", tutorials: [
        { tutorial_type: "pdf", display_text: "מסמך" },
        { tutorial_type: "webpage", display_text: "עמוד", link: "https://example.invalid/information" },
        { tutorial_type: "video", display_text: "סרטון", link: "https://example.invalid/video" },
      ] },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|reference_id|timestamp|hash|"url"/);
  });

  test("accepts an empty captured list", () => {
    expect(projectGeneralMailings([])).toEqual([]);
  });

  test("rejects changed or incomplete attachment branches", () => {
    for (const value of [
      [{ ...common, letter_type: 4 }],
      [{ ...common, letter_type: 1, letter_desc: "text" }],
      [{ ...common, letter_type: 2, status: 1, link: "path" }],
      [{ ...common, letter_type: 2, status: 7 }],
      [{ ...common, letter_type: 3, service_type_text: "service", practitioner_name: "name", tutorials: [{ tutorial_type: "pdf", display_text: "doc", url: "path" }] }],
      [{ ...common, letter_type: 3, service_type_text: "service", practitioner_name: "name", tutorials: [{ tutorial_type: "other", display_text: "doc", url: "path" }] }],
      [{ ...common, letter_type: 3, service_type_text: "service", practitioner_name: "name", tutorials: [{ tutorial_type: "webpage", display_text: "doc", url: "javascript:alert(1)" }] }],
      [{ ...common, letter_type: 3, service_type_text: "service", practitioner_name: "name", tutorials: [{ tutorial_type: "video", display_text: "doc", url: "https://user:pass@example.invalid/private" }] }],
    ]) expect(() => projectGeneralMailings(value)).toThrow();
  });
});
