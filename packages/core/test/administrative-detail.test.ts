import { describe, expect, test } from "vitest";
import { AdministrativeDetailContentError, projectAdministrativeDetail } from "../src/readers/administrative-detail";

describe("administrative detail projection", () => {
  test("projects a service-request body and visible documents without private routing fields", () => {
    const result = projectAdministrativeDetail({
      body: "בקשה לדוגמה",
      documents: [{ file_name: "מסמך", uri: "private/path", timestamp: "time", hash: "signature" }],
      extended_properties: { hidden_branch: "not projected" },
    }, "ServiceRequest", "interaction");
    expect(result.detail).toEqual({
      classification: "ServiceRequest",
      coverage: "common",
      body: "בקשה לדוגמה",
      messages: [],
      attachments: [{ file_name: "מסמך", reference: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      obligation_details: null,
      decision: null,
      unsupported_sections: ["extended_properties"],
    });
    expect(result.documents).toEqual([{ kind: "query", reference: result.detail.attachments[0]!.reference, uri: "private/path", timestamp: "time", hash: "signature" }]);
    expect(projectAdministrativeDetail({ body: "בקשה לדוגמה", documents: [{ file_name: "מסמך", uri: "private/path", timestamp: "rotated", hash: "rotated" }] }, "ServiceRequest", "interaction").detail.attachments[0]!.reference).toBe(result.detail.attachments[0]!.reference);
    expect(JSON.stringify(result.detail)).not.toMatch(/private\/path|signature|hidden_branch/);
  });

  test("projects case messages and only the first message's rendered documents", () => {
    const result = projectAdministrativeDetail({
      body: "not a generic case field",
      messages: [
        { created_on: "2026-01-01", body: "תשובה", from_maccabi: true, documents: [{ file_name: "תשובה מצורפת", uri: "first", timestamp: "one", hash: "hash-one" }] },
        { created_on: "2026-01-02", body: "המשך", from_maccabi: false, documents: [{ file_name: "not rendered by the common message component", uri: "second", timestamp: "two", hash: "hash-two" }] },
      ],
      documents: [{ file_name: "feature gated", uri: "gated", timestamp: "three", hash: "hash-three" }],
    }, "Case", 42);
    expect(result.detail.body).toBeNull();
    expect(result.detail.messages).toEqual([
      { created_on: "2026-01-01", body: "תשובה", from_maccabi: true },
      { created_on: "2026-01-02", body: "המשך", from_maccabi: false },
    ]);
    expect(result.detail.attachments).toHaveLength(1);
    expect(result.detail.unsupported_sections).toEqual(["feature_gated_case_documents"]);
    expect(result.documents[0]!.kind === "query" && result.documents[0]!.uri).toBe("first");
    expect(JSON.stringify(result.detail)).not.toMatch(/hash-|"first"|"second"/);
  });

  test("accepts empty common content and rejects ambiguous or unsafe shapes", () => {
    expect(projectAdministrativeDetail({}, "Case", "case").detail).toEqual({ classification: "Case", coverage: "common", body: null, messages: [], attachments: [], obligation_details: null, decision: null, unsupported_sections: [] });
    for (const value of [
      { messages: [{ created_on: "date", body: "body", from_maccabi: "yes" }] },
      { messages: [{ created_on: "date", body: "body", from_maccabi: true, documents: {} }] },
      { messages: new Array(1001).fill({}) },
    ]) expect(() => projectAdministrativeDetail(value, "Case", "case")).toThrow(AdministrativeDetailContentError);
    expect(() => projectAdministrativeDetail({ documents: [{ file_name: "file", uri: "", timestamp: "time", hash: "hash" }] }, "ServiceRequest", "request")).toThrow(AdministrativeDetailContentError);
  });

  test("projects exact provider, treatment, medication and decision-document consumers", () => {
    const result = projectAdministrativeDetail({
      treatment_date: "2026-03-01",
      unified_status_code: 51,
      messages: [{ created_on: "2026-02-01", body: "patient message", from_maccabi: false }],
      extended_properties: {
        obligation_details: {
          doctor_referral: { doctor_referral_code: 17, doctor_referral_name: "Referral fixture" },
          treatment_array: [{ health_ministry_code: "A1", treatment_name: "Treatment fixture" }],
          department: { department_description: "Department fixture" },
          service_provider: { service_provider_name: "Provider fixture" },
        },
        medication_approval: {
          approval_number: "approval",
          medication_name: "Medication fixture",
          largo_code: "123",
          valid_from_date: "from",
          valid_to_date: "to",
          participation: "participation",
          pharmacies: "pharmacy fixture",
          print_document_title: "Decision fixture",
          print_document_uri: "private%2Fdecision",
          timestamp: "time-one",
          hash: "hash-one",
        },
      },
    }, "Case", "case");
    expect(result.detail.obligation_details).toEqual({
      treatment_date: "2026-03-01",
      doctor_referral: { code: 17, name: "Referral fixture" },
      treatments: [{ health_ministry_code: "A1", treatment_name: "Treatment fixture" }],
      department_description: "Department fixture",
      service_provider_name: "Provider fixture",
    });
    expect(result.detail.decision).toMatchObject({ kind: "medication_approval", approval_number: "approval", medication: { medication_name: "Medication fixture", largo_code: "123" } });
    expect(result.detail.attachments).toEqual([{ file_name: "Decision fixture", reference: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    const rotated = structuredClone(result.documents[0]!);
    if (rotated.kind !== "query") throw new Error("synthetic fixture expected query document");
    const again = projectAdministrativeDetail({
      unified_status_code: 51,
      messages: [],
      extended_properties: { medication_approval: { approval_number: "approval", print_document_title: "Decision fixture", print_document_uri: rotated.uri, timestamp: "time-two", hash: "hash-two" } },
    }, "Case", "case");
    expect(again.detail.attachments[0]!.reference).toBe(result.detail.attachments[0]!.reference);
    expect(JSON.stringify(result.detail)).not.toMatch(/private%2Fdecision|hash-one|time-one/);
  });

  test("projects root case documents only under the exact three-feature source gate", () => {
    const value = {
      case_type_code: 75,
      has_documents_from_maccabi: true,
      documents: [{ title: "Feature document", uri: "private-feature", timestamp: "time", hash: "hash" }],
    };
    const unresolved = projectAdministrativeDetail(value, "Case", "case");
    expect(unresolved.detail.attachments).toEqual([]);
    expect(unresolved.detail.unsupported_sections).toContain("feature_gated_case_documents");
    const hidden = projectAdministrativeDetail(value, "Case", "case", { IshurMakdim: false, IsCaseRejected: false, EnablePartlyApprovedObligation: false });
    expect(hidden.detail.attachments).toEqual([]);
    expect(hidden.detail.unsupported_sections).not.toContain("feature_gated_case_documents");
    const shown = projectAdministrativeDetail(value, "Case", "case", { IshurMakdim: false, IsCaseRejected: true, EnablePartlyApprovedObligation: false });
    expect(shown.detail.attachments).toEqual([{ file_name: "Feature document", reference: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(shown.documents[0]!.kind === "query" && shown.documents[0]!.uri).toBe("private-feature");
    const untitled = projectAdministrativeDetail({ ...value, documents: [{ uri: "untitled", timestamp: "time", hash: "hash" }] }, "Case", "case", { IshurMakdim: false, IsCaseRejected: true, EnablePartlyApprovedObligation: false });
    expect(untitled.detail.attachments[0]!.file_name).toBeNull();
  });

  test("keeps an already-returned printable provider PDF private and signature-independent", () => {
    const source = (base64: string) => ({
      messages: [],
      extended_properties: { obligation: { print_decision_type: "Print" } },
      provider_document: { last_doc_name_reviced: "Provider decision", file_base64string: base64 },
    });
    const first = projectAdministrativeDetail(source("JVBERi0x"), "Case", "case");
    expect(first.detail.attachments).toEqual([{ file_name: "Provider decision", reference: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(first.detail.unsupported_sections).not.toContain("provider_document");
    expect(first.documents[0]).toMatchObject({ kind: "base64", file_name: "Provider decision", base64: "JVBERi0x" });
    const rotated = projectAdministrativeDetail(source("JVBERi0y"), "Case", "case");
    expect(rotated.detail.attachments[0]!.reference).toBe(first.detail.attachments[0]!.reference);
    expect(JSON.stringify(first.detail)).not.toContain("JVBER");
  });
});
