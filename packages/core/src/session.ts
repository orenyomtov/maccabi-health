import type { SerializedCookieJar } from "tough-cookie";

/** Sensitive session material. Store with a protected adapter, never in logs. */
export interface MaccabiSession {
  version: 1;
  cookies: SerializedCookieJar;
  authenticatedAt: string;
  apiAuthorization?: string;
}
