import { describe, expect, test } from "vitest";
import { projectFutureAppointments } from "../src/readers/future-appointments";

describe("future appointment frontend projection", () => {
  test("keeps the fixed visible Maccabi timeline fields and omits routing and write controls", () => {
    const result = projectFutureAppointments([{
      date: "source-date",
      provider_name: "רופא לדוגמה",
      provider_service_type: "תחום לדוגמה",
      description: "תיאור מקורי",
      category_visit_type: 2,
      ascribed_doctor: true,
      ascribed_doctor_gender: 1,
      waiting_list_status: "3",
      provider_role: "fixture-role",
      id: "private-appointment-id",
      object_id: "private-object-id",
      employee_id: "private-employee-id",
      permissions: "8",
      phone_for_contact: "private-phone",
    }]);
    expect(result).toEqual([{
      date: "source-date",
      provider_name: "רופא לדוגמה",
      provider_service_type: "תחום לדוגמה",
      description: "תיאור מקורי",
      category_visit_type: 2,
      ascribed_doctor: true,
      ascribed_doctor_gender: 1,
      subsidiary_name: null,
      facility_category: null,
      follow_up_appointments_count: null,
      waiting_list_status: "3",
      provider_role: "fixture-role",
    }]);
    expect(JSON.stringify(result)).not.toMatch(/private|permissions|phone_for_contact|object_id|employee_id/);
  });

  test("supports the separate subsidiary display branch without exposing its route identity", () => {
    expect(projectFutureAppointments([{
      date: "source-date",
      provider_service_type: "שירות לדוגמה",
      subsidiary_name: "חברת קבוצה לדוגמה",
      facility_category: "קטגוריה לדוגמה",
      follow_up_appointments_count: 2,
      category_visit_type: 3,
      external_id: "private-external-id",
    }])).toEqual([expect.objectContaining({
      provider_name: null,
      subsidiary_name: "חברת קבוצה לדוגמה",
      follow_up_appointments_count: 2,
    })]);
  });

  test("accepts the captured empty shape", () => {
    expect(projectFutureAppointments([])).toEqual([]);
  });

  test("rejects missing required display fields and changed scalar shapes", () => {
    for (const value of [
      {},
      [{ date: "source-date", provider_service_type: "תחום" }],
      [{ date: "", provider_name: "רופא", provider_service_type: "תחום" }],
      [{ date: "source-date", provider_name: "רופא", provider_service_type: "תחום", category_visit_type: "2" }],
      [{ date: "source-date", provider_name: "רופא", provider_service_type: "תחום", follow_up_appointments_count: -1 }],
      [{ date: "source-date", provider_name: "רופא", provider_service_type: "תחום", ascribed_doctor: 1 }],
    ]) expect(() => projectFutureAppointments(value)).toThrow();
  });
});
