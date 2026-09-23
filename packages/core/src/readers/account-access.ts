export interface AccountAccessUser {
  first_name: string;
  last_name: string;
  /** Identification number displayed by the permissions page. */
  user_id: string | number;
  /** Source value used by the page to display the current authorization end date. */
  authentication_end_date: string;
}

export interface AccountAccess {
  /** Normalized from the first response message branch consumed by the page. */
  state: "viewer-list" | "creation-available";
  users: AccountAccessUser[];
}

export class AccountAccessContentError extends Error {}

const fail = (): never => { throw new AccountAccessContentError(); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 16_384): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail();
  return value as string;
}
function visibleId(value: unknown): string | number {
  if (typeof value === "string") return text(value, 512);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return fail();
}

/** Fixed projection consumed by the ordinary account-permissions viewer. */
export function projectAccountAccess(value: unknown): AccountAccess {
  const response = record(value);
  const messages: unknown[] = Array.isArray(response.messages) ? response.messages : fail();
  if (messages.length !== 1) fail();
  const message = record(messages[0]);
  const type = text(message.type, 128);
  text(message.message, 16_384);
  const state: AccountAccess["state"] = type === "S-Success" ? "viewer-list" : type === "W-Warning" ? "creation-available" : fail();
  const rawUsers: unknown[] = response.users === null ? [] : Array.isArray(response.users) ? response.users : fail();
  if (rawUsers.length > 100) fail();
  if (state === "creation-available" && rawUsers.length !== 0) fail();
  const users = (rawUsers as unknown[]).map(raw => {
    const user = record(raw);
    return {
      first_name: text(user.first_name),
      last_name: text(user.last_name),
      user_id: visibleId(user.user_id),
      authentication_end_date: text(user.authentication_end_date, 512),
    };
  });
  const result: AccountAccess = { state, users };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) fail();
  return result;
}
