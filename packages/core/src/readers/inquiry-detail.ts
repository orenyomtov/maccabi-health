export interface InquiryPrescriptionRequest {
  drug_name: string;
}

export interface InquiryApprovalRequest {
  approval_required_from: string | null;
  approval_required_to: string | null;
  approval_additional_text: string;
  approval_description?: string;
}

export interface InquiryClinicalRequestProjection {
  prescription_largo_code_list: InquiryPrescriptionRequest[];
  approval_request_details: InquiryApprovalRequest[];
  /** Present in edit state, but not consumed by the observed read timeline. */
  unsupported_sections: "prescription_user_drugs_indication"[];
}

export class InquiryClinicalRequestContentError extends Error {
  constructor() {
    super("Maccabi inquiry clinical request fields do not match the observed renderer");
    this.name = "InquiryClinicalRequestContentError";
  }
}

const fail = (): never => { throw new InquiryClinicalRequestContentError(); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const text = (value: unknown, maximum = 16_384): string => typeof value === "string" && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? value : fail();
const nullableText = (value: unknown): string | null => value === null ? null : text(value, 512);
const rows = (value: unknown): unknown[] => Array.isArray(value) && value.length <= 100 ? value : fail();

/** Fields consumed by the source timeline for prescription and approval request subjects. */
export function projectInquiryClinicalRequests(value: unknown): InquiryClinicalRequestProjection {
  const detail = record(value);
  const prescription_largo_code_list = rows(detail.prescription_largo_code_list).map(item => {
    const row = record(item);
    return { drug_name: text(row.drug_name, 4096) };
  });
  const approval_request_details = rows(detail.approval_request_details).map(item => {
    const row = record(item);
    const projected: InquiryApprovalRequest = {
      approval_required_from: nullableText(row.approval_required_from),
      approval_required_to: nullableText(row.approval_required_to),
      approval_additional_text: text(row.approval_additional_text),
    };
    if (row.approval_description !== undefined) projected.approval_description = text(row.approval_description, 4096);
    return projected;
  });
  const indications = rows(detail.prescription_user_drugs_indication);
  const result: InquiryClinicalRequestProjection = {
    prescription_largo_code_list,
    approval_request_details,
    unsupported_sections: indications.length ? ["prescription_user_drugs_indication"] : [],
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) fail();
  return result;
}
