import type { SerializedCookieJar } from "tough-cookie";
import { AuthenticationError } from "./errors";
import type { MaccabiSession } from "./session";
import { LOGIN_ORIGIN, MaccabiTransport, PORTAL_ORIGIN, readResponseBody } from "./transport";

export interface LoginPhoneChoice {
  index: number;
  label: string;
  /**
   * The bare value with no "Phone" prefix and no `(option N)` disambiguator, for embedding in a
   * sentence ("sent to 052-*****63"). `label` is for a numbered menu instead ("1. Phone 052-*****63"),
   * so the two carry different text and neither is derived from the other by string surgery.
   */
  display: string;
  smsAvailable: boolean;
}

export interface LoginChallenge {
  id: string;
  phones: LoginPhoneChoice[];
}

/** A challenge handed to another process. Holds bearer tokens and cookies: keep it in protected storage. */
export interface PendingLogin {
  version: 1;
  id: string;
  memberId: number;
  senderJwt: string;
  validatorJwt?: string;
  phones: LoginPhoneChoice[];
  expiresAt: number;
  cookies: SerializedCookieJar;
}

interface ChallengeState {
  id: string;
  memberId: number;
  senderJwt: string;
  validatorJwt?: string;
  phones: LoginPhoneChoice[];
  expiresAt: number;
  busy: boolean;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function jwt(value: JsonObject): string {
  if (typeof value.jwt !== "string" || !value.jwt || /[\r\n]/.test(value.jwt)) {
    throw new AuthenticationError("AUTH_RESPONSE_CHANGED");
  }
  return value.jwt;
}

/** One interactive sign-in at a time. Prompts and protected persistence belong to callers. */
export class MaccabiAuth {
  readonly transport: MaccabiTransport;
  readonly #now: () => number;
  readonly #challengeTtlMs: number;
  #challenge?: ChallengeState;
  #starting = false;

  constructor(
    transport = new MaccabiTransport(),
    options: { now?: () => number; challengeTtlMs?: number } = {},
  ) {
    this.transport = transport;
    this.#now = options.now ?? Date.now;
    // Local secret-retention policy, not a claim about Maccabi's token lifetime.
    this.#challengeTtlMs = options.challengeTtlMs ?? 10 * 60_000;
  }

  async beginLogin(idNumber: string): Promise<LoginChallenge> {
    if (!/^\d{1,9}$/.test(idNumber)) throw new AuthenticationError("INVALID_ID_FORMAT");
    if (this.#starting || this.#challenge) throw new AuthenticationError("LOGIN_ALREADY_STARTED");
    this.#starting = true;
    try {
      await this.transport.clearSession();
      const login = await this.transport.request(PORTAL_ORIGIN + "/");
      if (!login.ok) throw new AuthenticationError("LOGIN_PAGE_UNAVAILABLE", login.status);
      const html = await readResponseBody(() => login.text(), new AuthenticationError("AUTH_RESPONSE_CHANGED", login.status));
      // Observed login HTML assignment; never evaluate upstream JavaScript.
      const originJwt = /(?:window\.)?originJWT\s*=\s*["']([A-Za-z0-9_.-]+)["']/.exec(html)?.[1];
      if (!originJwt) throw new AuthenticationError("LOGIN_PAGE_CHANGED");
      const auth = await this.#api("/auth", originJwt, {
        method: "POST",
        body: JSON.stringify({ id: `0-${Number.parseInt(idNumber, 10)}`, password: "", type: "none" }),
      });
      const details = await this.#api("/otp/detailsV2", jwt(auth));
      if (!object(details.details)) throw new AuthenticationError("AUTH_RESPONSE_CHANGED");
      const upstreamPhones = details.details.phones ?? [];
      if (!Array.isArray(upstreamPhones)) throw new AuthenticationError("AUTH_RESPONSE_CHANGED");
      if (details.details.allowedAge !== true || details.details.digitalUser !== true) throw new AuthenticationError("LOGIN_NOT_AVAILABLE");
      const seenPhones = new Set<string>();
      const phones: LoginPhoneChoice[] = [];
      upstreamPhones.forEach((phone: unknown, index: number) => {
        if (!object(phone) || typeof phone.number !== "string" || typeof phone.mobile !== "boolean" || typeof phone.kosher !== "boolean") {
          throw new AuthenticationError("AUTH_RESPONSE_CHANGED");
        }
        // Deduplicate exact upstream entries, never a shortened display suffix.
        // Keep the first original index, as the public frontend's SMS action does.
        const key = JSON.stringify([phone.number, phone.mobile, phone.kosher]);
        if (seenPhones.has(key)) return;
        seenPhones.add(key);
        const suppliedMask = /[*xX•]/.test(phone.number)
          ? phone.number.replace(/[^\d*+xX•() -]/g, "") : undefined;
        const tail = phone.number.replace(/\D/g, "").slice(-4);
        // `display` is computed alongside `label` from the same three shapes, not derived from
        // `label` by stripping a prefix: the "ending NNNN" and ordinal shapes never had one.
        const display = suppliedMask ?? (tail ? `ending ${tail}` : `${index + 1}`);
        phones.push({
          index,
          label: suppliedMask ? `Phone ${suppliedMask}` : tail ? `Phone ending ${tail}` : `Phone ${index + 1}`,
          display,
          smsAvailable: phone.mobile && !phone.kosher,
        });
      });
      // Distinct full numbers can still share their masked label. Do not merge them.
      const labels = new Map<string, number>();
      for (const phone of phones) labels.set(phone.label, (labels.get(phone.label) ?? 0) + 1);
      for (const phone of phones) if ((labels.get(phone.label) ?? 0) > 1) phone.label += ` (option ${phone.index + 1})`;
      if (!phones.some(phone => phone.smsAvailable)) throw new AuthenticationError("SMS_NOT_AVAILABLE");
      this.#challenge = {
        id: crypto.randomUUID(), memberId: Number.parseInt(idNumber, 10), senderJwt: jwt(details), phones,
        expiresAt: this.#now() + this.#challengeTtlMs, busy: false,
      };
      return { id: this.#challenge.id, phones: phones.map(phone => ({ ...phone })) };
    } finally {
      this.#starting = false;
    }
  }

  /** Explicit user action only; never automatically resend an SMS. */
  async requestOtp(challengeId: string, phoneIndex?: number): Promise<void> {
    const challenge = this.#getChallenge(challengeId);
    const selected = phoneIndex ?? challenge.phones.find(phone => phone.smsAvailable)?.index;
    if (selected === undefined || !challenge.phones.some(phone => phone.index === selected && phone.smsAvailable)) {
      throw new AuthenticationError("INVALID_PHONE_CHOICE");
    }
    challenge.busy = true;
    try {
      const response = await this.#api(`/otp/generateV2?target=sms&phone=${selected}`, challenge.senderJwt);
      challenge.validatorJwt = jwt(response);
    } finally { challenge.busy = false; }
  }

  async completeLogin(challengeId: string, otp: string): Promise<MaccabiSession> {
    const challenge = this.#getChallenge(challengeId);
    if (!/^\d{6}$/.test(otp)) throw new AuthenticationError("INVALID_OTP_FORMAT");
    if (!challenge.validatorJwt) throw new AuthenticationError("OTP_NOT_REQUESTED");
    challenge.busy = true;
    try {
      const verified = await this.#api(`/otp/validate?otp=${encodeURIComponent(otp)}`, challenge.validatorJwt);
      if (verified.status !== "ok") throw new AuthenticationError("OTP_REJECTED");
      const handoff = await this.#api("/response", jwt(verified), { headers: { relay: "home" } });
      if (handoff.status !== "ok" || handoff.method !== "post" || handoff.destination !== PORTAL_ORIGIN + "/saml/sp/profile/post/acs" || !object(handoff.payload)) {
        throw new AuthenticationError("SAML_RESPONSE_CHANGED");
      }
      const { SAMLResponse, RelayState } = handoff.payload;
      if (typeof SAMLResponse !== "string" || typeof RelayState !== "string") throw new AuthenticationError("SAML_RESPONSE_CHANGED");
      const response = await this.transport.request(handoff.destination, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: LOGIN_ORIGIN },
        body: new URLSearchParams({ RelayState, SAMLResponse }),
      });
      const html = await readResponseBody(() => response.text(), new AuthenticationError("AUTH_RESPONSE_CHANGED", response.status));
      if (!response.ok || response.url !== PORTAL_ORIGIN + "/sonline/homepage/NotificationAndUpdates/" ||
        !response.headers.get("content-type")?.includes("text/html") ||
        /(?:window\.)?originJWT\s*=/.test(html) || !await this.transport.hasPortalSession()) {
        throw new AuthenticationError("PORTAL_SESSION_UNCONFIRMED");
      }
      this.transport.markAuthenticated();
      this.#challenge = undefined;
      return await this.transport.exportSession();
    } catch (error) {
      if (error instanceof AuthenticationError && ["OTP_EXPIRED", "LOGIN_BLOCKED"].includes(error.code)) this.#challenge = undefined;
      throw error;
    } finally { challenge.busy = false; }
  }

  /** Hand the open challenge to another process; its mid-login cookies travel with it. */
  async exportPending(): Promise<PendingLogin> {
    const challenge = this.#getChallenge(this.#challenge?.id ?? "");
    return {
      version: 1, id: challenge.id, memberId: challenge.memberId, senderJwt: challenge.senderJwt,
      ...(challenge.validatorJwt ? { validatorJwt: challenge.validatorJwt } : {}),
      phones: challenge.phones.map(phone => ({ ...phone })),
      expiresAt: challenge.expiresAt, cookies: await this.transport.exportCookies(),
    };
  }

  /** Adopt a challenge an earlier process exported. Its remaining steps are unchanged. */
  restorePending(pending: PendingLogin): void {
    if (this.#starting || this.#challenge) throw new AuthenticationError("LOGIN_ALREADY_STARTED");
    if (pending.version !== 1 || typeof pending.id !== "string" || typeof pending.senderJwt !== "string" ||
      !Number.isSafeInteger(pending.memberId) || !Array.isArray(pending.phones) || !Number.isFinite(pending.expiresAt)) {
      throw new AuthenticationError("UNKNOWN_LOGIN_CHALLENGE");
    }
    if (this.#now() >= pending.expiresAt) throw new AuthenticationError("LOGIN_CHALLENGE_EXPIRED");
    this.transport.importCookies(pending.cookies);
    this.#challenge = {
      id: pending.id, memberId: pending.memberId, senderJwt: pending.senderJwt, validatorJwt: pending.validatorJwt,
      phones: pending.phones, expiresAt: pending.expiresAt, busy: false,
    };
  }

  async cancelLogin(): Promise<void> {
    if (this.#starting || this.#challenge?.busy) throw new AuthenticationError("LOGIN_STEP_IN_PROGRESS");
    this.#challenge = undefined;
    await this.transport.clearSession();
  }

  #getChallenge(id: string): ChallengeState {
    const challenge = this.#challenge;
    if (!challenge || challenge.id !== id) throw new AuthenticationError("UNKNOWN_LOGIN_CHALLENGE");
    if (this.#now() >= challenge.expiresAt) {
      this.#challenge = undefined;
      throw new AuthenticationError("LOGIN_CHALLENGE_EXPIRED");
    }
    if (challenge.busy) throw new AuthenticationError("LOGIN_STEP_IN_PROGRESS");
    return challenge;
  }

  async #api(path: string, token: string, init: RequestInit = {}): Promise<JsonObject> {
    const url = new URL("/infosec" + path, LOGIN_ORIGIN);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("origin", LOGIN_ORIGIN);
    headers.set("accept", "application/json; charset=utf-8");
    headers.set("content-type", "application/json; charset=utf-8");
    if (url.pathname !== "/infosec/auth") {
      url.searchParams.set("_", String(this.#now()));
      headers.set("cache-control", "no-cache, no-store, must-revalidate");
      headers.set("pragma", "no-cache");
      headers.set("expires", "0");
    }
    const response = await this.transport.request(url, { ...init, headers });
    const value: unknown = await readResponseBody(() => response.json(), new AuthenticationError("AUTH_RESPONSE_CHANGED", response.status));
    if (!object(value)) throw new AuthenticationError("AUTH_RESPONSE_CHANGED", response.status);
    if (!response.ok) {
      const code = value.code === 302 ? "OTP_EXPIRED" : [301, 304].includes(Number(value.code)) ? "LOGIN_BLOCKED" : [300, 303].includes(Number(value.code)) ? "OTP_REJECTED" : "AUTHENTICATION_FAILED";
      throw new AuthenticationError(code, response.status);
    }
    return value;
  }
}
