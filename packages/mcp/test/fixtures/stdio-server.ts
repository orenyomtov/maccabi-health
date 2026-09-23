/** Entirely synthetic subprocess fixture. No live account, saved session or network. */
import { MaccabiTransport } from "@maccabi/core";
import { startLocalMcp } from "../../src/stdio";
const transport = new MaccabiTransport();
transport.markAuthenticated(); transport.setApiToken("synthetic-saved-token");
let session = await transport.exportSession();
const owner = { memberId: 123456789, memberIdCode: "0" };
const profile = { member_id: owner.memberId, member_id_code: "0", f_name_hebrew: "דוגמה", l_name_hebrew: "בדיקה", f_name_english: "Example", l_name_english: "Fixture", sex: "synthetic", birth_date: "2000-01-01" };
startLocalMcp({
  resolveSession: async () => ({ session, owner, save: async next => { session = next; }, invalidate: async () => {} }),
  fetch: async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/members/token/full")) return Response.json({ logged_customer_info: profile, current_customer_info: profile, token: { content: "synthetic-upstream-token", success: true } });
    if (path.endsWith("/tests")) return Response.json({ categories: [], tests: [2024, 2025].map(year => ({ request_id: `fixture-request-${year}`, doc_id: `fixture-doc-${year}`, type: "lab_result", execute_date: `${year}-01-01T00:00:00`, result_date: `${year}-01-02T00:00:00`, test_name: ["בדיקה לדוגמה"], member_id: String(owner.memberId), member_id_code: 0 })) });
    throw new Error("Unexpected synthetic request; external network is disabled.");
  },
});
