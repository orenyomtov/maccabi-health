import { MaccabiAuth, MaccabiError, MaccabiReaders, MaccabiTransport, type LoginChallenge, type MaccabiSession, type OwnerIdentity, type PendingLogin } from "@maccabi/core";
import { CredentialStore, FilePendingLoginStore, FileSessionStore, PendingLoginStore } from "./store";

export interface LoginAuthDriver {
  beginLogin(id: string): Promise<LoginChallenge>;
  requestOtp(id: string, phoneIndex?: number): Promise<void>;
  completeLogin(id: string, otp: string): Promise<MaccabiSession>;
  exportPending(): Promise<PendingLogin>;
  restorePending(pending: PendingLogin): void;
  cancelLogin(): Promise<void>;
}
export interface LoginConnected { readers: Pick<MaccabiReaders, "currentOwner">; exportSession(): Promise<MaccabiSession> }
export interface LoginDependencies {
  store: CredentialStore;
  pending: PendingLoginStore;
  createAuth(): LoginAuthDriver;
  connect(session: MaccabiSession, expectedOwner?: OwnerIdentity): Promise<LoginConnected>;
}
/** Self-authored message; upstream text and the values the caller passed in are never part of it. */
export class LoginError extends MaccabiError {}

export type LoginStart =
  | { status: "sms-sent"; phone: string; expiresInSeconds: number }
  | { status: "phone-required"; phones: { option: number; label: string }[]; expiresInSeconds: number };
export type LoginStatus =
  | { status: "signed-in" }
  | { status: "pending-login"; smsSent: boolean; expiresInSeconds: number }
  | { status: "signed-out" };
export type LoginVerified = { status: "signed-in"; persistence: "session-file" };
export type LoggedOut = { status: "local-session-removed" };

const remainingSeconds = (expiresAt: number) => Math.max(0, Math.round((expiresAt - Date.now()) / 1000));

/** Phone options are numbered from one for the caller; upstream indexes are not contiguous. */
export async function startLogin(deps: LoginDependencies, id: string, phoneOption?: number): Promise<LoginStart> {
  if (!/^\d{1,9}$/.test(id)) throw new LoginError("INVALID_ID_FORMAT", "The ID number must be digits only, at most nine of them. Nothing was sent.");
  await deps.store.load(); // Fail on an unusable session file before requesting an SMS.
  const auth = deps.createAuth();
  try {
    const challenge = await auth.beginLogin(id);
    const choices = challenge.phones.filter(phone => phone.smsAvailable);
    if (phoneOption === undefined && choices.length > 1) {
      // Picking for the member would send the code to a phone they may not hold.
      const pending = await auth.exportPending();
      await deps.pending.save(pending);
      return { status: "phone-required", phones: choices.map(phone => ({ option: phone.index + 1, label: phone.label })), expiresInSeconds: remainingSeconds(pending.expiresAt) };
    }
    // Checked here rather than up front because only `beginLogin` knows which numbers this ID offers.
    // It sends no SMS, so a wrong choice still costs nothing and the valid numbers can be named back.
    const options = choices.map(phone => phone.index + 1);
    if (phoneOption !== undefined && !options.includes(phoneOption)) {
      throw new LoginError("INVALID_PHONE_CHOICE", `Choose one of the option numbers this ID offers: ${options.join(", ")}. Nothing was sent.`);
    }
    const selected = phoneOption === undefined ? choices[0]?.index : phoneOption - 1;
    await auth.requestOtp(challenge.id, selected);
    const pending = await auth.exportPending();
    await deps.pending.save(pending);
    return { status: "sms-sent", phone: choices.find(phone => phone.index === selected)!.display, expiresInSeconds: remainingSeconds(pending.expiresAt) };
  } catch (error) {
    await auth.cancelLogin().catch(() => {});
    await deps.pending.delete().catch(() => {});
    throw error;
  }
}

export async function verifyLogin(deps: LoginDependencies, code: string): Promise<LoginVerified> {
  if (!/^\d{6}$/.test(code)) throw new LoginError("INVALID_OTP_FORMAT", "The SMS code is six digits. Nothing was verified, so the code is still usable.");
  const pending = await deps.pending.load();
  if (!pending) throw new LoginError("NO_PENDING_LOGIN", "No login is waiting for a code here. Start one again; a challenge expires ten minutes after it begins.");
  const auth = deps.createAuth();
  try {
    auth.restorePending(pending);
    const session = await auth.completeLogin(pending.id, code);
    const connected = await deps.connect(session, { memberId: pending.memberId, memberIdCode: "0" });
    await deps.store.save({ session: await connected.exportSession(), owner: connected.readers.currentOwner });
    await deps.pending.delete();
    return { status: "signed-in", persistence: "session-file" };
  } catch (error) {
    // One code per SMS: repeated attempts against the same challenge are what lock the Maccabi account.
    await deps.pending.delete().catch(() => {});
    await auth.cancelLogin().catch(() => {});
    throw error;
  }
}

export async function loginStatus(deps: LoginDependencies): Promise<LoginStatus> {
  if (await deps.store.load()) return { status: "signed-in" };
  const pending = await deps.pending.load();
  if (!pending) return { status: "signed-out" };
  return { status: "pending-login", smsSent: pending.validatorJwt !== undefined, expiresInSeconds: remainingSeconds(pending.expiresAt) };
}

export async function logoutLocal(deps: LoginDependencies): Promise<LoggedOut> {
  await deps.store.delete();
  await deps.pending.delete();
  return { status: "local-session-removed" };
}

export interface LoginHandle {
  start(id: string, phoneOption?: number): Promise<LoginStart>;
  verify(code: string): Promise<LoginVerified>;
  status(): Promise<LoginStatus>;
  logout(): Promise<LoggedOut>;
}
export function fileLoginDependencies(): LoginDependencies {
  return {
    store: new FileSessionStore(), pending: new FilePendingLoginStore(),
    createAuth: () => new MaccabiAuth(),
    async connect(session, expectedOwner) {
      const transport = new MaccabiTransport({ session });
      return { readers: await MaccabiReaders.create(transport, expectedOwner), exportSession: () => transport.exportSession() };
    },
  };
}
export function login(deps: LoginDependencies = fileLoginDependencies()): LoginHandle {
  return {
    start: (id, phoneOption) => startLogin(deps, id, phoneOption),
    verify: code => verifyLogin(deps, code),
    status: () => loginStatus(deps),
    logout: () => logoutLocal(deps),
  };
}
