import { describe, expect, test } from "vitest";
import { projectFutureAppointmentDetail } from "../src/readers/future-appointment-detail";

const appointment = {
  date: "source-date",
  provider_name: "רופא לדוגמה",
  provider_service_type: "תחום לדוגמה",
  category_visit_type: 3,
  object_id: "private-object",
  employee_id: "private-employee",
  permissions: "8",
};

describe("future appointment detail frontend projection", () => {
  test("preserves rendered clinic contacts and instructions without routing or write controls", () => {
    const result = projectFutureAppointmentDetail(appointment, {
      provider_details: { full: "כתובת מרפאה מקורית", internal: "private" },
      contacts: [
        { code: "02", contact_details: "טלפון לזימון" },
        { code: "01", contact_details: "טלפון מרפאה" },
        { code: "03", contact_details: "פקס מרפאה" },
        { code: "99", contact_details: "private-other-contact" },
      ],
      sap_key: { employee_id: "private" },
    }, {
      visit_description: "source gate",
      specific_visits_instructions: [
        { description: "הנחיה מקורית", link: "https://example.invalid/instructions" },
        { description: "הנחיה נוספת", link: null },
      ],
    });
    expect(result.provider).toEqual({ address: "כתובת מרפאה מקורית", order_appointment_phone: "טלפון לזימון", phone: "טלפון מרפאה", fax: "פקס מרפאה" });
    expect(result.instructions).toEqual([{ description: "הנחיה מקורית", link: "https://example.invalid/instructions" }, { description: "הנחיה נוספת", link: null }]);
    expect(JSON.stringify(result)).not.toMatch(/private|object_id|employee_id|permissions/);
  });

  test("does not expose a provider address in branches where the frontend does not render it", () => {
    expect(projectFutureAppointmentDetail({ ...appointment, category_visit_type: 2 }, { provider_details: { full: "hidden" }, contacts: [] }, { visit_description: "gate", specific_visits_instructions: [] }).provider.address).toBeNull();
  });

  test("rejects malformed provider contacts and instruction shapes", () => {
    for (const [provider, instructions] of [
      [{ provider_details: {}, contacts: [{ code: "01", contact_details: 7 }] }, { visit_description: "gate", specific_visits_instructions: [] }],
      [{ provider_details: {}, contacts: [{ code: "01", contact_details: "one" }, { code: "01", contact_details: "two" }] }, { visit_description: "gate", specific_visits_instructions: [] }],
      [{ provider_details: {}, contacts: [] }, { specific_visits_instructions: [] }],
      [{ provider_details: {}, contacts: [] }, { visit_description: "gate", specific_visits_instructions: [{ description: "text", link: 7 }] }],
      [{ provider_details: {}, contacts: [] }, { visit_description: "gate", specific_visits_instructions: [{ description: "text", link: "javascript:alert(1)" }] }],
      [{ provider_details: {}, contacts: [] }, { visit_description: "gate", specific_visits_instructions: [{ description: "text", link: "https://user:pass@example.invalid/private" }] }],
    ] as const) expect(() => projectFutureAppointmentDetail(appointment, provider, instructions)).toThrow();
  });
});
