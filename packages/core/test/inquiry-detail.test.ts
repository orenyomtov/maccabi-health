import { describe, expect, test } from "vitest";
import { InquiryClinicalRequestContentError, projectInquiryClinicalRequests } from "../src/readers/inquiry-detail";

describe("inquiry clinical request projection", () => {
  test("preserves the prescription and approval fields rendered by the read timeline", () => {
    const source = {
      prescription_largo_code_list: [{ drug_name: "תרופה לדוגמה", private_code: "omit" }],
      approval_request_details: [{
        approval_required_from: "2030-01-01T00:00:00",
        approval_required_to: null,
        approval_additional_text: "טקסט מקור",
        approval_description: "תיאור מקור",
        private_type: "omit",
      }],
      prescription_user_drugs_indication: [],
    };
    const projected = projectInquiryClinicalRequests(source);
    expect(projected).toEqual({
      prescription_largo_code_list: [{ drug_name: "תרופה לדוגמה" }],
      approval_request_details: [{ approval_required_from: "2030-01-01T00:00:00", approval_required_to: null, approval_additional_text: "טקסט מקור", approval_description: "תיאור מקור" }],
      unsupported_sections: [],
    });
    source.prescription_largo_code_list[0]!.drug_name = "mutated";
    expect(projected.prescription_largo_code_list[0]!.drug_name).toBe("תרופה לדוגמה");
    expect(JSON.stringify(projected)).not.toContain("private");
  });

  test("does not reject the readable request when edit-only indication state is populated", () => {
    expect(projectInquiryClinicalRequests({
      prescription_largo_code_list: [], approval_request_details: [], prescription_user_drugs_indication: [{ source: "unprojected" }],
    })).toEqual({ prescription_largo_code_list: [], approval_request_details: [], unsupported_sections: ["prescription_user_drugs_indication"] });
  });

  test("rejects missing, malformed, unsafe, and oversized renderer fields", () => {
    for (const value of [
      {},
      { prescription_largo_code_list: {}, approval_request_details: [], prescription_user_drugs_indication: [] },
      { prescription_largo_code_list: [{}], approval_request_details: [], prescription_user_drugs_indication: [] },
      { prescription_largo_code_list: [{ drug_name: "x\u0000" }], approval_request_details: [], prescription_user_drugs_indication: [] },
      { prescription_largo_code_list: [], approval_request_details: [{ approval_required_from: 1, approval_required_to: null, approval_additional_text: "x" }], prescription_user_drugs_indication: [] },
      { prescription_largo_code_list: [], approval_request_details: Array.from({ length: 101 }, () => ({})), prescription_user_drugs_indication: [] },
    ]) expect(() => projectInquiryClinicalRequests(value)).toThrow(InquiryClinicalRequestContentError);
  });
});
