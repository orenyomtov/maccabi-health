import type { SerializedCookieJar } from "tough-cookie";

/** Sensitive session material. Store with a protected adapter, never in logs. */
export interface MaccabiSession {
  version: 1;
  cookies: SerializedCookieJar;
  authenticatedAt: string;
  apiAuthorization?: string;
}

/** Implementations belong to the CLI/server and must provide protected storage. */
export interface SessionStore {
  load(): Promise<MaccabiSession | null>;
  save(session: MaccabiSession): Promise<void>;
  delete(): Promise<void>;
}
