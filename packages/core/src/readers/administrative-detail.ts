import { createHash } from "node:crypto";

export type AdministrativeClassification = "Case" | "ServiceRequest";

export interface AdministrativeMessage {
  created_on: string;
  body: string;
  from_maccabi: boolean;
}

export interface AdministrativeAttachment {
  file_name: string | null;
  reference: string;
}

export interface AdministrativeFeatureContext {
  IshurMakdim: boolean;
  IsCaseRejected: boolean;
  EnablePartlyApprovedObligation: boolean;
}

export type AdministrativeDisplayValue = string | number;

export interface AdministrativeObligationDetails {
  treatment_date?: string;
  doctor_referral?: { code?: AdministrativeDisplayValue; name?: string };
  treatments: { health_ministry_code?: AdministrativeDisplayValue; treatment_name?: string }[];
  department_description?: string;
  service_provider_name?: string;
}

export interface AdministrativeDecision {
  kind: "medication_approval" | "obligation" | "preauthorization" | "refund" | "ombudsman";
  service_provider?: string;
  approval_number?: AdministrativeDisplayValue;
  obligation_number?: AdministrativeDisplayValue;
  print_decision_message?: string;
  print_decision_type?: string;
  medication?: {
    medication_name?: string;
    largo_code?: AdministrativeDisplayValue;
    valid_from_date?: string;
    valid_to_date?: string;
    participation?: AdministrativeDisplayValue;
    pharmacies?: string;
  };
}

export interface AdministrativeDetail {
  classification: AdministrativeClassification;
  coverage: "common";
  body: string | null;
  messages: AdministrativeMessage[];
  attachments: AdministrativeAttachment[];
  obligation_details?: AdministrativeObligationDetails | null;
  decision?: AdministrativeDecision | null;
  unsupported_sections: ("extended_properties" | "feature_gated_case_documents" | "provider_document")[];
}

export type PrivateAdministrativeDocument = {
  kind: "query";
  reference: string;
  uri: string;
  timestamp: string;
  hash: string;
} | {
  kind: "base64";
  reference: string;
  file_name: string;
  base64: string;
};

export class AdministrativeDetailContentError extends Error {
  constructor() {
    super("Maccabi administrative detail does not match the official frontend projection");
    this.name = "AdministrativeDetailContentError";
  }
}

const fail = (): never => { throw new AdministrativeDetailContentError(); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const boundedString = (value: unknown): string => typeof value === "string" && value.length <= 64 * 1024 ? value : fail();
const text = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 64 * 1024 ? value : fail();
const optionalBody = (value: unknown): string | null => value === undefined || value === null ? null : boundedString(value);
const rows = (value: unknown): unknown[] => value === undefined || value === null ? [] : Array.isArray(value) && value.length <= 1000 ? value : fail();
const display = (value: unknown): AdministrativeDisplayValue | undefined => {
  if (value === undefined || value === null || value === "" || value === 0) return undefined;
  if ((typeof value === "string" && value.length <= 64 * 1024) || (typeof value === "number" && Number.isFinite(value))) return value as AdministrativeDisplayValue;
  return fail();
};
const displayText = (value: unknown): string | undefined => {
  const selected = display(value);
  if (selected === undefined) return undefined;
  return typeof selected === "string" ? selected : fail();
};
const base64Text = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 3 * 1024 * 1024 ? value : fail();

/**
 * Bounded fields rendered by the official Case and ServiceRequest expansion view.
 * Payment state, feature-gated root case documents and inline provider documents stay out.
 */
export function projectAdministrativeDetail(
  value: unknown,
  classification: AdministrativeClassification,
  interactionId: string | number,
  features?: AdministrativeFeatureContext,
): { detail: AdministrativeDetail; documents: PrivateAdministrativeDocument[] } {
  if (!(classification === "Case" || classification === "ServiceRequest")) fail();
  if (!((typeof interactionId === "string" && interactionId.length > 0 && interactionId.length <= 512)
    || (typeof interactionId === "number" && Number.isFinite(interactionId)))) fail();
  const detail = record(value);

  const messages: AdministrativeMessage[] = classification === "Case"
    ? rows(detail.messages).map(raw => {
      const message = record(raw);
      if (typeof message.from_maccabi !== "boolean") fail();
      const from_maccabi = message.from_maccabi as boolean;
      return { created_on: text(message.created_on), body: boundedString(message.body), from_maccabi };
    })
    : [];

  // This mirrors the normal renderer: service-request documents come from the detail
  // root, while a generic case exposes the first message's documents.
  const documentRows = classification === "ServiceRequest"
    ? rows(detail.documents)
    : messages.length > 0 ? rows(record((detail.messages as unknown[])[0]).documents) : [];
  const references = new Set<string>();
  const projectDocument = (raw: unknown, selection: string, titleField = "file_name", allowMissingTitle = false) => {
    const document = record(raw);
    const file_name = allowMissingTitle && (document[titleField] === undefined || document[titleField] === null || document[titleField] === "") ? null : text(document[titleField]);
    const uri = text(document.print_document_uri || document.uri);
    const timestamp = text(document.timestamp);
    const hash = text(document.hash);
    // This identifies the current list/detail selection, not immutable document bytes.
    // A refreshed download may legitimately rotate its timestamp or signature.
    const reference = createHash("sha256").update(JSON.stringify([classification, String(interactionId), selection, uri])).digest("hex");
    if (references.has(reference)) fail();
    references.add(reference);
    return { public: { file_name, reference }, private: { kind: "query" as const, reference, uri, timestamp, hash } };
  };
  const documents: { public: AdministrativeAttachment; private: PrivateAdministrativeDocument }[] = documentRows.map((raw, index) => projectDocument(raw, `common:${index}`));

  const extended = detail.extended_properties === undefined || detail.extended_properties === null ? null : record(detail.extended_properties);
  let obligation_details: AdministrativeObligationDetails | null = null;
  if (extended?.obligation_details !== undefined && extended.obligation_details !== null) {
    const source = record(extended.obligation_details);
    const doctor = source.doctor_referral === undefined || source.doctor_referral === null ? null : record(source.doctor_referral);
    const department = source.department === undefined || source.department === null ? null : record(source.department);
    const provider = source.service_provider === undefined || source.service_provider === null ? null : record(source.service_provider);
    obligation_details = {
      ...(displayText(detail.treatment_date) !== undefined ? { treatment_date: displayText(detail.treatment_date) } : {}),
      ...(doctor && (display(doctor.doctor_referral_code) !== undefined || displayText(doctor.doctor_referral_name) !== undefined) ? { doctor_referral: {
        ...(display(doctor.doctor_referral_code) !== undefined ? { code: display(doctor.doctor_referral_code) } : {}),
        ...(displayText(doctor.doctor_referral_name) !== undefined ? { name: displayText(doctor.doctor_referral_name) } : {}),
      } } : {}),
      treatments: rows(source.treatment_array).map(raw => {
        const treatment = record(raw);
        return {
          ...(display(treatment.health_ministry_code) !== undefined ? { health_ministry_code: display(treatment.health_ministry_code) } : {}),
          ...(displayText(treatment.treatment_name) !== undefined ? { treatment_name: displayText(treatment.treatment_name) } : {}),
        };
      }),
      ...(department && displayText(department.department_description) !== undefined ? { department_description: displayText(department.department_description) } : {}),
      ...(provider && displayText(provider.service_provider_name) !== undefined ? { service_provider_name: displayText(provider.service_provider_name) } : {}),
    };
  }

  const decisionKinds = ["medication_approval", "obligation", "refund", "preauthorization", "ombudsman"] as const;
  const decisionKind = classification === "Case" && extended ? decisionKinds.find(kind => extended[kind] !== undefined && extended[kind] !== null) : undefined;
  const decisionSource = decisionKind ? record(extended![decisionKind]) : null;
  let decision: AdministrativeDecision | null = null;
  let printableDecision = false;
  if (decisionKind && decisionSource) {
    decision = {
      kind: decisionKind,
      ...(displayText(decisionSource.service_provider) !== undefined ? { service_provider: displayText(decisionSource.service_provider) } : {}),
      ...(display(decisionSource.approval_number) !== undefined ? { approval_number: display(decisionSource.approval_number) } : {}),
      ...(display(decisionSource.obligation_number) !== undefined ? { obligation_number: display(decisionSource.obligation_number) } : {}),
      ...(displayText(decisionSource.print_decision_message) !== undefined ? { print_decision_message: displayText(decisionSource.print_decision_message) } : {}),
      ...(displayText(decisionSource.print_decision_type) !== undefined ? { print_decision_type: displayText(decisionSource.print_decision_type) } : {}),
    };
    const firstMaccabiMessage = messages.find(message => message.from_maccabi);
    const status = detail.unified_status_code;
    if (decisionKind === "medication_approval" && !firstMaccabiMessage && display(decisionSource.approval_number) !== undefined && (status === 51 || status === 57)) {
      decision.medication = {
        ...(displayText(decisionSource.medication_name) !== undefined ? { medication_name: displayText(decisionSource.medication_name) } : {}),
        ...(display(decisionSource.largo_code) !== undefined ? { largo_code: display(decisionSource.largo_code) } : {}),
        ...(displayText(decisionSource.valid_from_date) !== undefined ? { valid_from_date: displayText(decisionSource.valid_from_date) } : {}),
        ...(displayText(decisionSource.valid_to_date) !== undefined ? { valid_to_date: displayText(decisionSource.valid_to_date) } : {}),
        ...(display(decisionSource.participation) !== undefined ? { participation: display(decisionSource.participation) } : {}),
        ...(displayText(decisionSource.pharmacies) !== undefined ? { pharmacies: displayText(decisionSource.pharmacies) } : {}),
      };
    }
    const printableObligation = decisionKind === "obligation" && ["Print", "Print_ProviderChangeDisabled"].includes(decisionSource.print_decision_type as string);
    printableDecision = decisionKind === "medication_approval" || decisionKind === "refund" || decisionKind === "preauthorization" || decisionKind === "ombudsman" || printableObligation;
    if (printableDecision
      && displayText(decisionSource.print_document_title) !== undefined) {
      documents.push(projectDocument(decisionSource, "decision", "print_document_title"));
    }
  }

  let projectedProviderDocument = false;
  if (printableDecision && detail.provider_document !== undefined && detail.provider_document !== null) {
    const provider = record(detail.provider_document);
    const file_name = text(provider.last_doc_name_reviced);
    const base64 = base64Text(provider.file_base64string);
    const reference = createHash("sha256").update(JSON.stringify([classification, String(interactionId), "provider", file_name])).digest("hex");
    if (references.has(reference)) fail();
    references.add(reference);
    documents.push({ public: { file_name, reference }, private: { kind: "base64", reference, file_name, base64 } });
    projectedProviderDocument = true;
  }

  const caseType = detail.case_type_code;
  const unifiedStatus = detail.unified_status_code;
  const hasCaseDocuments = classification === "Case" && detail.has_documents_from_maccabi === true && (caseType === 53 || caseType === 75);
  const candidateCaseDocuments = classification === "Case" && rows(detail.documents).length > 0;
  if (features && candidateCaseDocuments) {
    for (const value of Object.values(features)) if (typeof value !== "boolean") fail();
    const renderCaseDocuments = (features.IshurMakdim && decisionKind === "preauthorization")
      || (features.IsCaseRejected && hasCaseDocuments)
      || (features.EnablePartlyApprovedObligation && caseType === 53 && unifiedStatus === 91);
    if (renderCaseDocuments) rows(detail.documents).forEach((raw, index) => {
      const document = record(raw);
      if (document.uri || document.print_document_uri) documents.push(projectDocument(document, `case-root:${index}`, "title", true));
    });
  }

  const projected: AdministrativeDetail = {
    classification,
    coverage: "common",
    body: classification === "ServiceRequest" ? optionalBody(detail.body) : null,
    messages,
    attachments: documents.map(document => document.public),
    obligation_details,
    decision,
    unsupported_sections: [
      ...(extended && obligation_details === null && decision === null ? ["extended_properties" as const] : []),
      ...(candidateCaseDocuments && !features ? ["feature_gated_case_documents" as const] : []),
      ...(detail.provider_document !== undefined && detail.provider_document !== null && !projectedProviderDocument ? ["provider_document" as const] : []),
    ],
  };
  if (Buffer.byteLength(JSON.stringify(projected)) > 256 * 1024) fail();
  return { detail: projected, documents: documents.map(document => document.private) };
}
