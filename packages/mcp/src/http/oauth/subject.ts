import { createHash } from "node:crypto";
import { join } from "node:path";
import type { OwnerIdentity } from "@maccabi/core";

/** The subject is the Maccabi member, not the OAuth client: two clients for one member share one credential file. */
export function subjectOf(owner: OwnerIdentity): string {
  return createHash("sha256").update(`maccabi-mcp/subject/v1|${owner.memberId}|${owner.memberIdCode}`).digest("hex").slice(0, 32);
}

/** Thirty-two hex characters by construction, but asserted anyway: this value becomes a path segment. */
export function credentialPath(sessionsDir: string, subject: string): string {
  if (!/^[0-9a-f]{32}$/.test(subject)) throw new Error("Refusing to derive a credential path from a malformed subject.");
  return join(sessionsDir, `${subject}.json`);
}
