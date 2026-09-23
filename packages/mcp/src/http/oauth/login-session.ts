import { randomBytes, timingSafeEqual } from "node:crypto";
import type { MaccabiSession, OwnerIdentity, PendingLogin } from "@maccabi/core";
import { FileSessionStore, type CredentialStore, type PendingLoginStore, type SavedLogin } from "@maccabi/cli/store";
import { credentialPath, subjectOf } from "./subject";

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const MAX_SESSIONS = 8;
export const SMS_WINDOW_MS = 60 * 1000;
export const MAX_SMS_PER_WINDOW = 5;
export const COOKIE_NAME = "maccabi_login";

export interface AuthorizeParams { clientId: string; redirectUri: string; state?: string; codeChallenge: string; resource: string; scope: string; clientLabel: string }
export interface AuthorizeSession {
  id: string;
  csrf: string;
  expiresAt: number;
  params: AuthorizeParams;
  phase: "id" | "phone" | "otp";
  memberId?: string;
  phones?: { option: number; label: string }[];
  phoneLabel?: string;
  pending: PendingLogin | null;
  /** The subject the completed login wrote to, filled in by the store below once the credential lands. */
  subject?: string;
}

const newId = () => randomBytes(16).toString("hex");
function equalTokens(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8"), right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * In-flight browser sign-ins, held in memory only. HTTP mode deliberately has no `pending-login.json`:
 * a single process-wide pending file lets two concurrent sign-ins clobber each other's challenge, and
 * answering a clobbered challenge with the wrong code is exactly what locks a Maccabi account. Each
 * session carries its own `MaccabiAuth`, so the challenges cannot see each other at all.
 */
export class AuthorizeSessions {
  #sessions = new Map<string, AuthorizeSession>();
  #smsAt: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  create(params: AuthorizeParams): AuthorizeSession | null {
    this.sweep();
    if (this.#sessions.size >= MAX_SESSIONS) return null;
    const session: AuthorizeSession = { id: newId(), csrf: newId(), expiresAt: this.now() + SESSION_TTL_MS, params, phase: "id", pending: null };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): AuthorizeSession | null {
    if (id === undefined) return null;
    const session = this.#sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.now()) { this.#sessions.delete(id); return null; }
    return session;
  }

  delete(id: string): void { this.#sessions.delete(id); }
  sweep(): void { for (const [id, session] of this.#sessions) if (session.expiresAt <= this.now()) this.#sessions.delete(id); }
  get size(): number { return this.#sessions.size; }

  checkCsrf(session: AuthorizeSession, presented: string | undefined): boolean {
    return presented !== undefined && equalTokens(session.csrf, presented);
  }

  /**
   * Damage limitation, not security: `/authorize` is unauthenticated, so without this any local
   * process can loop the first form step and burn the member's SMS quota into a Maccabi lockout.
   */
  takeSmsSlot(): boolean {
    const now = this.now();
    this.#smsAt = this.#smsAt.filter(at => at + SMS_WINDOW_MS > now);
    if (this.#smsAt.length >= MAX_SMS_PER_WINDOW) return false;
    this.#smsAt.push(now);
    return true;
  }
}

export function sessionCookie(id: string): string {
  // Path=/authorize keeps it off /mcp and /token; a cookie those endpoints can see would be a CSRF surface on them.
  return `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Lax; Path=/authorize; Max-Age=${SESSION_TTL_MS / 1000}`;
}
export function clearedCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/authorize; Max-Age=0`;
}
export function readCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return undefined;
}

/** One half-finished challenge, scoped to one browser session instead of one process. */
export class MemoryPendingLoginStore implements PendingLoginStore {
  constructor(private readonly session: AuthorizeSession) {}
  async load(): Promise<PendingLogin | null> { return this.session.pending; }
  async save(pending: PendingLogin): Promise<void> { this.session.pending = pending; }
  async delete(): Promise<void> { this.session.pending = null; }
}

/**
 * Writes the completed login to `sessions/<subject>.json`. `load()` returns null on purpose:
 * `startLogin` only calls it to fail early on an unusable session file, and in HTTP mode the member's
 * file is not selected until the ID has been typed and the OTP has passed.
 */
export class SubjectRoutedStore implements CredentialStore {
  constructor(private readonly sessionsDir: string, private readonly session: AuthorizeSession) {}
  async load(): Promise<SavedLogin | null> { return null; }
  async save(login: SavedLogin): Promise<void> {
    const subject = subjectOf(login.owner);
    this.session.subject = subject;
    await new FileSessionStore(credentialPath(this.sessionsDir, subject)).save(login);
  }
  async delete(): Promise<void> {
    if (this.session.subject !== undefined) await new FileSessionStore(credentialPath(this.sessionsDir, this.session.subject)).delete();
  }
}

/** The one resolver HTTP mode uses: a single member's file, chosen by the verified token's subject. */
export function subjectSessionResolver(sessionsDir: string, subject: string, onInvalidate: () => Promise<void>) {
  const store = new FileSessionStore(credentialPath(sessionsDir, subject));
  return async () => {
    const saved = await store.load();
    if (!saved) return null;
    return {
      session: saved.session, owner: saved.owner,
      save: (session: MaccabiSession) => store.save({ session, owner: saved.owner }),
      // Both layers, in this order. Leaving the OAuth token alive while the Maccabi credential is gone
      // strands the client: every call answers REAUTHENTICATION_REQUIRED and nothing makes it re-authorize.
      invalidate: async () => { await store.delete(); await onInvalidate(); },
      reauthentication: { instruction: HTTP_REAUTH_INSTRUCTION },
    };
  };
}

export const HTTP_REAUTH_INSTRUCTION = "This member is signed out. The access token has been revoked, so retry the request and let the MCP client re-run authorization; it opens a browser window for the Maccabi sign-in. No ID number or SMS code passes through this conversation.";

export type { OwnerIdentity };
